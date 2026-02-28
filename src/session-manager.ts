/**
 * Session Manager - owns session lifecycle, command execution, and subscriber maps.
 *
 * Server commands handled here. Session commands delegated to command-router.
 * Extension UI requests tracked by ExtensionUIManager.
 */

import {
  type AgentSession,
  createAgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type {
  CommandLifecycleEvent,
  RpcCommand,
  RpcEvent,
  RpcResponse,
  SessionInfo,
  SessionResolver,
  Subscriber,
} from "./types.js";
import {
  getCommandDependsOn,
  getCommandId,
  getCommandIdempotencyKey,
  getCommandIfSessionVersion,
  getCommandType,
  getSessionId,
} from "./types.js";
import { routeSessionCommand } from "./command-router.js";
import { ExtensionUIManager } from "./extension-ui.js";
import { createServerUIContext } from "./server-ui-context.js";
import { validateCommand, formatValidationErrors } from "./validation.js";
import { ResourceGovernor, DEFAULT_CONFIG } from "./resource-governor.js";
import {
  CommandReplayStore,
  type InFlightCommandRecord,
  SYNTHETIC_ID_PREFIX,
} from "./command-replay-store.js";
import { SessionVersionStore } from "./session-version-store.js";
import { CommandExecutionEngine } from "./command-execution-engine.js";
import { SessionLockManager } from "./session-lock-manager.js";
import { SessionStore, type StoredSessionInfo } from "./session-store.js";
import { CircuitBreakerManager, type CircuitBreakerConfig } from "./circuit-breaker.js";

/** Default timeout for session commands (5 minutes for LLM operations) */
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Default graceful shutdown timeout (30 seconds) */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30 * 1000;

/** Short command timeout (30 seconds) */
const SHORT_COMMAND_TIMEOUT_MS = 30 * 1000;

/** Max time to wait for a dependency command to complete. */
const DEPENDENCY_WAIT_TIMEOUT_MS = 30 * 1000;

export interface SessionManagerRuntimeOptions {
  defaultCommandTimeoutMs?: number;
  shortCommandTimeoutMs?: number;
  dependencyWaitTimeoutMs?: number;
  idempotencyTtlMs?: number;
  /** Server version for session metadata tracking */
  serverVersion?: string;
  /** Circuit breaker configuration (optional, uses defaults if not provided) */
  circuitBreakerConfig?: Partial<Omit<CircuitBreakerConfig, "providerName">>;
}

export class PiSessionManager implements SessionResolver {
  private sessions = new Map<string, AgentSession>();
  private sessionCreatedAt = new Map<string, Date>();
  private subscribers = new Set<Subscriber>();
  private unsubscribers = new Map<string, () => void>();
  private governor: ResourceGovernor;

  /** Command replay and idempotency store. */
  private replayStore: CommandReplayStore;
  /** Session version store. */
  private versionStore: SessionVersionStore;
  /** Command execution engine. */
  private executionEngine: CommandExecutionEngine;
  /** Session ID lock manager for preventing create/delete races. */
  private lockManager: SessionLockManager;
  /** Session metadata store for persistence across restarts (ADR-0007). */
  private sessionStore: SessionStore;
  /** Circuit breaker for LLM providers (ADR-0010). */
  private circuitBreakers: CircuitBreakerManager;

  // Shutdown state (single source of truth - server.ts delegates to this)
  private isShuttingDown = false;
  private inFlightCommands = new Set<Promise<unknown>>();

  // Periodic cleanup timers
  private sessionExpirationTimer: NodeJS.Timeout | null = null;

  private readonly defaultCommandTimeoutMs: number;
  private readonly shortCommandTimeoutMs: number;
  private readonly dependencyWaitTimeoutMs: number;

  // Extension UI request tracking
  private extensionUI = new ExtensionUIManager((sessionId: string, event: AgentSessionEvent) =>
    this.broadcastEvent(sessionId, event)
  );

  constructor(governor?: ResourceGovernor, options: SessionManagerRuntimeOptions = {}) {
    this.governor = governor ?? new ResourceGovernor(DEFAULT_CONFIG);
    this.defaultCommandTimeoutMs =
      typeof options.defaultCommandTimeoutMs === "number" && options.defaultCommandTimeoutMs > 0
        ? options.defaultCommandTimeoutMs
        : DEFAULT_COMMAND_TIMEOUT_MS;
    this.shortCommandTimeoutMs =
      typeof options.shortCommandTimeoutMs === "number" && options.shortCommandTimeoutMs > 0
        ? options.shortCommandTimeoutMs
        : SHORT_COMMAND_TIMEOUT_MS;
    this.dependencyWaitTimeoutMs =
      typeof options.dependencyWaitTimeoutMs === "number" && options.dependencyWaitTimeoutMs > 0
        ? options.dependencyWaitTimeoutMs
        : DEPENDENCY_WAIT_TIMEOUT_MS;

    this.replayStore = new CommandReplayStore({
      idempotencyTtlMs: options.idempotencyTtlMs,
    });
    this.versionStore = new SessionVersionStore();
    this.executionEngine = new CommandExecutionEngine(
      this.replayStore,
      this.versionStore,
      this, // SessionResolver - the NEXUS seam
      {
        defaultCommandTimeoutMs: this.defaultCommandTimeoutMs,
        shortCommandTimeoutMs: this.shortCommandTimeoutMs,
        dependencyWaitTimeoutMs: this.dependencyWaitTimeoutMs,
      }
    );
    this.lockManager = new SessionLockManager();
    this.sessionStore = new SessionStore({
      serverVersion: options.serverVersion,
    });
    this.circuitBreakers = new CircuitBreakerManager(options.circuitBreakerConfig);
  }

  /**
   * Get the resource governor for external checks (e.g., message size).
   */
  getGovernor(): ResourceGovernor {
    return this.governor;
  }

  /**
   * Get the circuit breaker manager for external access (e.g., admin operations).
   */
  getCircuitBreakers(): CircuitBreakerManager {
    return this.circuitBreakers;
  }

  // ==========================================================================
  // SHUTDOWN MANAGEMENT
  // ==========================================================================

  /**
   * Check if the server is shutting down.
   */
  isInShutdown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Initiate graceful shutdown.
   * - Stops accepting new commands
   * - Broadcasts shutdown notification to all clients
   * - Returns promise that resolves when all in-flight commands complete or timeout
   *
   * Idempotent: calling multiple times returns the same result.
   */
  async initiateShutdown(
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS
  ): Promise<{ drained: number; timedOut: boolean }> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
    }

    // Idempotent check - only initiate once
    if (this.isShuttingDown) {
      // Return current state - how many commands are still in flight
      const remaining = this.inFlightCommands.size;
      return { drained: 0, timedOut: remaining > 0 };
    }

    this.isShuttingDown = true;

    // Broadcast shutdown notification
    const shutdownEvent = {
      type: "server_shutdown",
      data: { reason: "graceful_shutdown", timeoutMs },
    };
    this.broadcast(JSON.stringify(shutdownEvent));

    // Wait for in-flight commands with timeout
    const inFlightCount = this.inFlightCommands.size;

    if (inFlightCount === 0) {
      return { drained: 0, timedOut: false };
    }

    // Snapshot the current in-flight commands
    const snapshot = [...this.inFlightCommands];

    const drainPromise = Promise.allSettled(snapshot);

    const timeoutPromise = new Promise<{ drained: number; timedOut: boolean }>((resolve) => {
      setTimeout(() => {
        // Count how many from the original snapshot are still pending
        const stillPending = snapshot.filter((p) => this.inFlightCommands.has(p)).length;
        const drained = inFlightCount - stillPending;
        resolve({ drained, timedOut: true });
      }, timeoutMs);
    });

    const drainResult = new Promise<{ drained: number; timedOut: boolean }>((resolve) => {
      drainPromise.then(() => {
        resolve({ drained: inFlightCount, timedOut: false });
      });
    });

    return Promise.race([drainResult, timeoutPromise]);
  }

  /**
   * Dispose all sessions. Call after shutdown drain completes.
   */
  disposeAllSessions(): { disposed: number; failed: number } {
    let disposed = 0;
    let failed = 0;

    // Snapshot session IDs
    const sessionIds = [...this.sessions.keys()];

    for (const sessionId of sessionIds) {
      try {
        // Get session before removing
        const session = this.sessions.get(sessionId);

        // Remove from maps first
        this.sessions.delete(sessionId);
        this.sessionCreatedAt.delete(sessionId);

        // Unsubscribe
        const unsubscribe = this.unsubscribers.get(sessionId);
        if (unsubscribe) {
          this.unsubscribers.delete(sessionId);
          try {
            unsubscribe();
          } catch {
            // Ignore unsubscribe errors during disposal
          }
        }

        // Dispose session
        if (session) {
          try {
            session.dispose();
            disposed++;
          } catch {
            failed++;
          }
        }
      } catch {
        failed++;
      }
    }

    // Clear runtime registries
    this.versionStore.clear();
    this.executionEngine.clear();
    this.replayStore.clear();
    this.lockManager.clear();

    // Clear governor state
    this.governor.cleanupStaleData(new Set());

    return { disposed, failed };
  }

  /**
   * Get count of in-flight commands.
   */
  getInFlightCount(): number {
    return this.inFlightCommands.size;
  }

  /**
   * Register an in-flight command promise for shutdown draining.
   */
  private registerInFlightCommand<T>(promise: Promise<T>): void {
    this.inFlightCommands.add(promise);

    const cleanup = () => {
      this.inFlightCommands.delete(promise);
    };

    promise.then(cleanup, cleanup);
  }

  private broadcastCommandLifecycle(
    phase: CommandLifecycleEvent["type"],
    data: CommandLifecycleEvent["data"]
  ): void {
    const event: CommandLifecycleEvent = {
      type: phase,
      data,
    };
    this.broadcast(JSON.stringify(event));
  }

  // ==========================================================================
  // SESSION LIFECYCLE
  // ==========================================================================

  async createSession(sessionId: string, cwd?: string): Promise<SessionInfo> {
    // Validate session ID (validation doesn't need lock)
    const sessionIdError = this.governor.validateSessionId(sessionId);
    if (sessionIdError) {
      throw new Error(sessionIdError);
    }

    // Validate cwd if provided
    if (cwd) {
      const cwdError = this.governor.validateCwd(cwd);
      if (cwdError) {
        throw new Error(cwdError);
      }
    }

    // Acquire lock for this session ID to prevent concurrent create/delete races
    const lock = await this.lockManager.acquire(sessionId, "createSession");

    try {
      // Check for duplicate UNDER LOCK - prevents race condition
      if (this.sessions.has(sessionId)) {
        throw new Error(`Session ${sessionId} already exists`);
      }

      // Atomically reserve a session slot (prevents resource exhaustion)
      if (!this.governor.tryReserveSessionSlot()) {
        throw new Error(
          `Session limit reached (${this.governor.getConfig().maxSessions} sessions)`
        );
      }

      try {
        const { session } = await createAgentSession({
          cwd: cwd ?? process.cwd(),
        });

        // Wire extension UI - this is the nexus intervention!
        // Without this, extension UI requests (select, confirm, input, etc.) hang.
        await session.bindExtensions({
          uiContext: createServerUIContext(sessionId, this.extensionUI, (sid, event) =>
            this.broadcastEvent(sid, event)
          ),
        });

        // Final check still under lock - handles edge case of session creation side effects
        if (this.sessions.has(sessionId)) {
          session.dispose();
          throw new Error(`Session ${sessionId} already exists`);
        }

        this.sessions.set(sessionId, session);
        this.sessionCreatedAt.set(sessionId, new Date());
        this.versionStore.initialize(sessionId);
        // Record heartbeat (session count already incremented by tryReserveSessionSlot)
        this.governor.recordHeartbeat(sessionId);

        // Subscribe to all events from this session
        const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          this.broadcastEvent(sessionId, event);
        });
        this.unsubscribers.set(sessionId, unsubscribe);

        // ADR-0007: Persist session metadata
        const sessionInfo = this.getSessionInfo(sessionId)!;
        if (!session.sessionFile) {
          throw new Error("Session created without session file - cannot persist");
        }
        await this.sessionStore.save({
          sessionId,
          sessionFile: session.sessionFile,
          cwd: cwd ?? process.cwd(),
          createdAt: sessionInfo.createdAt,
          modelId: session.model?.id,
        });

        return sessionInfo;
      } catch (error) {
        // Release the slot if session creation failed
        this.governor.releaseSessionSlot();
        throw error;
      }
    } finally {
      lock.release();
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Acquire lock for this session ID to prevent concurrent create/delete races
    const lock = await this.lockManager.acquire(sessionId, "deleteSession");

    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      // Cancel any pending extension UI requests for this session
      this.extensionUI.cancelSessionRequests(sessionId);

      // Remove from maps first to prevent new operations
      this.sessions.delete(sessionId);
      this.sessionCreatedAt.delete(sessionId);
      this.versionStore.delete(sessionId);
      this.governor.unregisterSession(sessionId);

      // Clean up stale governor data for this session
      this.governor.cleanupStaleData(new Set(this.sessions.keys()));

      // Unsubscribe from events
      const unsubscribe = this.unsubscribers.get(sessionId);
      if (unsubscribe) {
        this.unsubscribers.delete(sessionId);
        try {
          unsubscribe();
        } catch (error) {
          console.error(`[deleteSession] Failed to unsubscribe:`, error);
        }
      }

      // Dispose the session
      try {
        session.dispose();
      } catch (error) {
        console.error(`[deleteSession] Failed to dispose session:`, error);
      }

      // Remove this session from all subscriber subscriptions
      for (const subscriber of this.subscribers) {
        subscriber.subscribedSessions.delete(sessionId);
      }

      // ADR-0007: Remove session metadata
      await this.sessionStore.delete(sessionId);
    } finally {
      lock.release();
    }
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionInfo(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const createdAt = this.sessionCreatedAt.get(sessionId);
    if (!createdAt) {
      // Invariant violation: session exists but createdAt is missing
      console.error(`[getSessionInfo] Missing createdAt for session ${sessionId}`);
      return undefined;
    }

    return {
      sessionId,
      sessionName: session.sessionName,
      sessionFile: session.sessionFile,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      messageCount: session.messages.length,
      createdAt: createdAt.toISOString(),
    };
  }

  listSessions(): SessionInfo[] {
    const infos: SessionInfo[] = [];
    for (const sessionId of this.sessions.keys()) {
      const info = this.getSessionInfo(sessionId);
      if (info) infos.push(info);
    }
    return infos;
  }

  // ==========================================================================
  // SESSION PERSISTENCE (ADR-0007)
  // ==========================================================================

  /**
   * List stored sessions that can be loaded.
   * These are sessions that existed in previous server runs OR discovered on disk.
   */
  async listStoredSessions(): Promise<StoredSessionInfo[]> {
    return this.sessionStore.listAllSessions();
  }

  /**
   * Load a session from a stored session file.
   * Creates a new in-memory session that reads from the existing session file.
   */
  async loadSession(sessionId: string, sessionPath: string): Promise<SessionInfo> {
    // Validate session ID
    const sessionIdError = this.governor.validateSessionId(sessionId);
    if (sessionIdError) {
      throw new Error(sessionIdError);
    }

    // Acquire lock for this session ID
    const lock = await this.lockManager.acquire(sessionId, "loadSession");

    try {
      // Check for duplicate UNDER LOCK
      if (this.sessions.has(sessionId)) {
        throw new Error(`Session ${sessionId} already exists`);
      }

      // Atomically reserve a session slot
      if (!this.governor.tryReserveSessionSlot()) {
        throw new Error(
          `Session limit reached (${this.governor.getConfig().maxSessions} sessions)`
        );
      }

      try {
        // Create session and switch to the specified file
        const { session } = await createAgentSession({
          cwd: process.cwd(),
        });

        // Switch to the specified session file
        const switched = await session.switchSession(sessionPath);
        if (!switched) {
          session.dispose();
          throw new Error(`Failed to load session from ${sessionPath}`);
        }

        // Wire extension UI
        await session.bindExtensions({
          uiContext: createServerUIContext(sessionId, this.extensionUI, (sid, event) =>
            this.broadcastEvent(sid, event)
          ),
        });

        // Final check still under lock
        if (this.sessions.has(sessionId)) {
          session.dispose();
          throw new Error(`Session ${sessionId} already exists`);
        }

        this.sessions.set(sessionId, session);
        this.sessionCreatedAt.set(sessionId, new Date());
        this.versionStore.initialize(sessionId);
        this.governor.recordHeartbeat(sessionId);

        // Subscribe to events
        const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          this.broadcastEvent(sessionId, event);
        });
        this.unsubscribers.set(sessionId, unsubscribe);

        // Update session metadata
        const sessionInfo = this.getSessionInfo(sessionId)!;
        if (!session.sessionFile) {
          throw new Error("Session loaded without session file - cannot persist metadata");
        }
        await this.sessionStore.save({
          sessionId,
          sessionFile: session.sessionFile,
          cwd: process.cwd(),
          createdAt: sessionInfo.createdAt,
          modelId: session.model?.id,
        });

        return sessionInfo;
      } catch (error) {
        this.governor.releaseSessionSlot();
        throw error;
      }
    } finally {
      lock.release();
    }
  }

  /**
   * Get the session store for direct access (e.g., cleanup).
   */
  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  /**
   * Start periodic cleanup of orphaned session metadata and expired sessions.
   * @param intervalMs Cleanup interval in milliseconds (default: 1 hour)
   */
  startSessionCleanup(intervalMs?: number): void {
    this.sessionStore.startPeriodicCleanup(intervalMs);
    this.startSessionExpirationCheck(intervalMs);
  }

  /**
   * Stop periodic cleanup.
   */
  stopSessionCleanup(): void {
    this.sessionStore.stopPeriodicCleanup();
    this.stopSessionExpirationCheck();
  }

  /**
   * Run a one-time cleanup of orphaned session metadata and expired sessions.
   */
  async cleanupSessions(): Promise<{ removed: number; kept: number }> {
    // Clean up expired sessions first
    await this.cleanupExpiredSessions();
    // Then clean up orphaned metadata
    return this.sessionStore.cleanup();
  }

  /**
   * Start periodic check for expired sessions (maxSessionLifetimeMs).
   */
  private startSessionExpirationCheck(intervalMs = 3600000): void {
    if (this.sessionExpirationTimer) {
      return; // Already running
    }

    this.sessionExpirationTimer = setInterval(() => {
      this.cleanupExpiredSessions().catch((error) => {
        console.error("[SessionManager] Session expiration cleanup failed:", error);
      });
    }, intervalMs);

    // Don't prevent process exit
    if (this.sessionExpirationTimer.unref) {
      this.sessionExpirationTimer.unref();
    }
  }

  /**
   * Stop periodic session expiration check.
   */
  private stopSessionExpirationCheck(): void {
    if (this.sessionExpirationTimer) {
      clearInterval(this.sessionExpirationTimer);
      this.sessionExpirationTimer = null;
    }
  }

  /**
   * Clean up sessions that have exceeded maxSessionLifetimeMs.
   * Also cleans up stale circuit breakers for unused providers.
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const expiredIds = this.governor.getExpiredSessions();

    for (const sessionId of expiredIds) {
      try {
        console.error(`[SessionManager] Deleting expired session: ${sessionId}`);
        await this.deleteSession(sessionId);
      } catch (error) {
        // Session may have been deleted already or deletion failed
        console.error(`[SessionManager] Failed to delete expired session ${sessionId}:`, error);
      }
    }

    // Clean up stale circuit breakers (ADR-0011)
    const staleBreakersRemoved = this.circuitBreakers.cleanupStaleBreakers();
    if (staleBreakersRemoved > 0) {
      console.error(`[SessionManager] Cleaned up ${staleBreakersRemoved} stale circuit breakers`);
    }
  }

  // ==========================================================================
  // SUBSCRIBER MANAGEMENT
  // ==========================================================================

  addSubscriber(subscriber: Subscriber): void {
    this.subscribers.add(subscriber);
  }

  removeSubscriber(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
  }

  subscribeToSession(subscriber: Subscriber, sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} not found`);
    }
    subscriber.subscribedSessions.add(sessionId);
  }

  unsubscribeFromSession(subscriber: Subscriber, sessionId: string): void {
    subscriber.subscribedSessions.delete(sessionId);
  }

  // ==========================================================================
  // EVENT BROADCAST
  // ==========================================================================

  private broadcastEvent(sessionId: string, event: AgentSessionEvent): void {
    // Note: extension_ui_request events are NOT AgentSessionEvents.
    // They come through ExtensionUIContext (wired via bindExtensions)
    // and are broadcast via createServerUIContext -> ExtensionUIManager.broadcastUIRequest.

    const rpcEvent: RpcEvent = {
      type: "event",
      sessionId,
      event,
    };

    let data: string;
    try {
      data = JSON.stringify(rpcEvent);
    } catch (error) {
      // Log serialization errors but don't crash
      console.error(`[broadcastEvent] JSON serialization failed:`, error);
      return;
    }

    // Snapshot subscribers to prevent mutation during iteration
    const snapshot = [...this.subscribers];
    for (const subscriber of snapshot) {
      if (subscriber.subscribedSessions.has(sessionId)) {
        try {
          subscriber.send(data);
        } catch (error) {
          // Log failed sends for observability
          console.error(`[broadcastEvent] Failed to send to subscriber:`, error);
          // Subscriber will be cleaned up by close handler
        }
      }
    }
  }

  broadcast(data: string): void {
    // Snapshot subscribers to prevent mutation during iteration
    const snapshot = [...this.subscribers];
    for (const subscriber of snapshot) {
      try {
        subscriber.send(data);
      } catch (error) {
        // Log failed sends for observability
        console.error(`[broadcast] Failed to send to subscriber:`, error);
      }
    }
  }

  // ==========================================================================
  // COMMAND EXECUTION
  // ==========================================================================

  async executeCommand(command: RpcCommand): Promise<RpcResponse> {
    const id = getCommandId(command);
    const commandType = getCommandType(command);
    const sessionId = getSessionId(command);
    const commandId = this.replayStore.getOrCreateCommandId(command);
    const dependsOn = getCommandDependsOn(command) ?? [];
    const ifSessionVersion = getCommandIfSessionVersion(command);
    const idempotencyKey = getCommandIdempotencyKey(command);
    const laneKey = this.executionEngine.getLaneKey(command);
    const fingerprint = this.replayStore.getCommandFingerprint(command);

    // Check for shutdown - reject new commands during shutdown
    if (this.isShuttingDown) {
      return {
        id,
        type: "response",
        command: commandType ?? "unknown",
        success: false,
        error: "Server is shutting down",
      };
    }

    // Input validation FIRST (don't rate-limit invalid commands)
    const validationErrors = validateCommand(command);
    if (validationErrors.length > 0) {
      return {
        id,
        type: "response",
        command: commandType ?? "unknown",
        success: false,
        error: `Validation failed: ${formatValidationErrors(validationErrors)}`,
      };
    }

    this.replayStore.cleanupIdempotencyCache();

    this.broadcastCommandLifecycle("command_accepted", {
      commandId,
      commandType,
      sessionId,
      dependsOn,
      ifSessionVersion,
      idempotencyKey,
    });

    // Check for replay opportunities or conflicts (ADR-0001: Free replay)
    // Replay is O(1) lookup - no execution cost, should not consume rate limit
    const replayCheck = this.replayStore.checkReplay(command, fingerprint);

    if (replayCheck.kind === "conflict") {
      this.broadcastCommandLifecycle("command_finished", {
        commandId,
        commandType,
        sessionId,
        dependsOn,
        ifSessionVersion,
        idempotencyKey,
        success: false,
        error: replayCheck.response.error,
      });
      return replayCheck.response;
    }

    if (replayCheck.kind === "replay_cached") {
      this.broadcastCommandLifecycle("command_finished", {
        commandId,
        commandType,
        sessionId,
        dependsOn,
        ifSessionVersion,
        idempotencyKey,
        success: replayCheck.response.success,
        error: replayCheck.response.success ? undefined : replayCheck.response.error,
        sessionVersion: replayCheck.response.sessionVersion,
        replayed: true,
      });
      return replayCheck.response;
    }

    if (replayCheck.kind === "replay_inflight") {
      const replayed = await replayCheck.promise;
      this.broadcastCommandLifecycle("command_finished", {
        commandId,
        commandType,
        sessionId,
        dependsOn,
        ifSessionVersion,
        idempotencyKey,
        success: replayed.success,
        error: replayed.success ? undefined : replayed.error,
        sessionVersion: replayed.sessionVersion,
        replayed: true,
      });
      return replayed;
    }

    // ADR-0001: Rate limiting only for NEW executions (replay is free)
    const rateLimitKey = sessionId ?? "_server_";
    const rateLimitResult = this.governor.canExecuteCommand(rateLimitKey);
    if (!rateLimitResult.allowed) {
      return {
        id,
        type: "response",
        command: commandType,
        success: false,
        error: rateLimitResult.reason,
      };
    }

    // Additional rate limiting for extension_ui_response (prevents spam)
    if (commandType === "extension_ui_response" && sessionId) {
      const extRateLimitResult = this.governor.canExecuteExtensionUIResponse(sessionId);
      if (!extRateLimitResult.allowed) {
        return {
          id,
          type: "response",
          command: commandType,
          success: false,
          error: extRateLimitResult.reason,
        };
      }
    }

    // Proceed with normal execution
    const commandExecution = this.executionEngine.runOnLane<RpcResponse>(
      laneKey,
      async (): Promise<RpcResponse> => {
        this.broadcastCommandLifecycle("command_started", {
          commandId,
          commandType,
          sessionId,
          dependsOn,
          ifSessionVersion,
          idempotencyKey,
        });

        if (dependsOn.includes(commandId)) {
          return {
            id,
            type: "response",
            command: commandType,
            success: false,
            error: `Command '${commandId}' cannot depend on itself`,
          };
        }

        if (dependsOn.length > 0) {
          const dependencyResult = await this.executionEngine.awaitDependencies(dependsOn, laneKey);
          if (!dependencyResult.ok) {
            return {
              id,
              type: "response",
              command: commandType,
              success: false,
              error: dependencyResult.error,
            };
          }
        }

        if (sessionId !== undefined && ifSessionVersion !== undefined) {
          const versionError = this.executionEngine.checkSessionVersion(
            sessionId,
            ifSessionVersion,
            commandType
          );
          if (versionError) {
            return {
              id,
              type: "response" as const,
              command: commandType,
              success: false,
              error: versionError.error,
            };
          }
        }

        const rawResponse = await this.executeCommandInternal(command, id, commandType);
        return this.versionStore.applyVersion(command, rawResponse);
      }
    );

    // Track in-flight if we have an explicit ID
    let inFlightRecord: InFlightCommandRecord | undefined;
    if (id) {
      inFlightRecord = {
        commandType,
        laneKey,
        fingerprint,
        promise: commandExecution,
      };

      // ADR-0001: Reject if in-flight limit reached (don't evict - breaks dependencies)
      const registered = this.replayStore.registerInFlight(id, inFlightRecord);
      if (!registered) {
        return {
          id,
          type: "response",
          command: commandType,
          success: false,
          error: "Server busy - too many concurrent commands. Please retry.",
        };
      }
    }

    // Cache idempotency result on completion
    if (idempotencyKey) {
      commandExecution.then((response) => {
        this.replayStore.cacheIdempotencyResult({
          command,
          idempotencyKey,
          commandType,
          fingerprint,
          response,
        });
      });
    }

    this.registerInFlightCommand(commandExecution);

    let response: RpcResponse;

    try {
      response = await this.executionEngine.executeWithTimeout(
        commandType,
        commandExecution,
        command
      );
    } catch (error) {
      // ADR-0001: Create timeout response and store it BEFORE returning
      response = {
        id,
        type: "response",
        command: commandType,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timedOut: true, // Mark as timeout for debugging
      };
    }

    // ADR-0001: ATOMIC OUTCOME STORAGE
    // Store outcome BEFORE returning (not in async callback)
    // This ensures same command ID always returns same response
    //
    // Only store outcomes for EXPLICIT client IDs (not synthetic IDs).
    // Synthetic IDs (anon:timestamp:seq) are server-generated for anonymous
    // commands and should not be stored to prevent unbounded memory growth.
    // Clients must provide explicit IDs if they want replay semantics.
    const isExplicitId = id && !id.startsWith(SYNTHETIC_ID_PREFIX);
    if (isExplicitId) {
      try {
        this.replayStore.storeCommandOutcome({
          commandId: id,
          commandType,
          laneKey,
          fingerprint,
          success: response.success,
          error: response.success ? undefined : response.error,
          response,
          sessionVersion: response.sessionVersion,
          finishedAt: Date.now(),
        });
      } catch (outcomeError) {
        console.error(`[executeCommand] Failed to store command outcome for ${id}:`, outcomeError);
      }

      // Unregister in-flight after storing outcome
      if (this.replayStore.getInFlight(id) === inFlightRecord) {
        this.replayStore.unregisterInFlight(id, inFlightRecord!);
      }
    } else if (id && this.replayStore.getInFlight(id) === inFlightRecord) {
      // Synthetic ID: still need to unregister in-flight
      this.replayStore.unregisterInFlight(id, inFlightRecord!);
    }

    this.broadcastCommandLifecycle("command_finished", {
      commandId,
      commandType,
      sessionId,
      dependsOn,
      ifSessionVersion,
      idempotencyKey,
      success: response.success,
      error: response.success ? undefined : response.error,
      sessionVersion: response.sessionVersion,
      replayed: response.replayed,
    });

    return response;
  }

  /**
   * Internal command execution (called after tracking and rate limiting).
   */
  private async executeCommandInternal(
    command: RpcCommand,
    id: string | undefined,
    commandType: string
  ): Promise<RpcResponse> {
    const failResponse = (error: string, responseCommand = commandType): RpcResponse => {
      return {
        id,
        type: "response",
        command: responseCommand,
        success: false,
        error,
      };
    };

    try {
      // Server commands (lifecycle management)
      switch (commandType) {
        case "list_sessions":
          return {
            id,
            type: "response",
            command: "list_sessions",
            success: true,
            data: { sessions: this.listSessions() },
          };

        case "create_session": {
          const cmd = command as { sessionId?: string; cwd?: string };
          const newSessionId = cmd.sessionId ?? this.generateSessionId();
          const sessionInfo = await this.createSession(newSessionId, cmd.cwd);
          return {
            id,
            type: "response",
            command: "create_session",
            success: true,
            data: { sessionId: newSessionId, sessionInfo },
          };
        }

        case "delete_session": {
          const cmd = command as { sessionId: string };
          await this.deleteSession(cmd.sessionId);
          return {
            id,
            type: "response",
            command: "delete_session",
            success: true,
            data: { deleted: true },
          };
        }

        case "switch_session": {
          const cmd = command as { sessionId: string };
          const sessionInfo = this.getSessionInfo(cmd.sessionId);
          if (!sessionInfo) {
            return failResponse(`Session ${cmd.sessionId} not found`, "switch_session");
          }
          return {
            id,
            type: "response",
            command: "switch_session",
            success: true,
            data: { sessionInfo },
          };
        }

        case "get_metrics": {
          const governorMetrics = this.governor.getMetrics();
          const replayStats = this.replayStore.getStats();
          const versionStats = this.versionStore.getStats();
          const executionStats = this.executionEngine.getStats();
          const lockStats = this.lockManager.getStats();
          const extensionUIStats = this.extensionUI.getStats();
          const circuitBreakerMetrics = this.circuitBreakers.getAllMetrics();
          return {
            id,
            type: "response",
            command: "get_metrics",
            success: true,
            data: {
              ...governorMetrics,
              stores: {
                replay: replayStats,
                version: versionStats,
                execution: executionStats,
                lock: lockStats,
                extensionUI: extensionUIStats,
              },
              circuitBreakers: circuitBreakerMetrics,
            },
          };
        }

        case "health_check": {
          const health = this.governor.isHealthy();
          const hasOpenCircuit = this.circuitBreakers.hasOpenCircuit();
          return {
            id,
            type: "response",
            command: "health_check",
            success: true,
            data: {
              ...health,
              hasOpenCircuit,
              issues: hasOpenCircuit
                ? [...health.issues, "One or more LLM provider circuits are open"]
                : health.issues,
            },
          };
        }

        // ADR-0007: Session persistence commands
        case "list_stored_sessions": {
          const storedSessions = await this.listStoredSessions();
          return {
            id,
            type: "response",
            command: "list_stored_sessions",
            success: true,
            data: { sessions: storedSessions },
          };
        }

        case "load_session": {
          const cmd = command as { sessionId?: string; sessionPath: string };
          const sessionId = cmd.sessionId ?? this.generateSessionId();
          try {
            const sessionInfo = await this.loadSession(sessionId, cmd.sessionPath);
            return {
              id,
              type: "response",
              command: "load_session",
              success: true,
              data: { sessionId, sessionInfo },
            };
          } catch (error) {
            return failResponse(
              error instanceof Error ? error.message : String(error),
              "load_session"
            );
          }
        }
      }

      // Session commands - get the session first
      const cmdSessionId = getSessionId(command);
      const session = this.sessions.get(cmdSessionId!);
      if (!session) {
        return failResponse(`Session ${cmdSessionId} not found`);
      }

      // Record heartbeat for valid session activity
      this.governor.recordHeartbeat(cmdSessionId!);

      // Special handling for extension_ui_response (doesn't operate on session directly)
      if (commandType === "extension_ui_response") {
        const cmd = command as { sessionId: string; requestId: string; response: any };
        const result = this.extensionUI.handleUIResponse({
          id,
          sessionId: cmd.sessionId,
          type: "extension_ui_response",
          requestId: cmd.requestId,
          response: cmd.response,
        });
        if (result.success) {
          return {
            id,
            type: "response",
            command: "extension_ui_response",
            success: true,
          };
        }
        return failResponse(result.error ?? "Unknown error", "extension_ui_response");
      }

      // ADR-0010: Circuit breaker for LLM commands
      // These commands make LLM calls and should be protected
      const LLM_COMMANDS = new Set(["prompt", "steer", "follow_up", "compact"]);
      const provider = session.model?.provider;

      if (LLM_COMMANDS.has(commandType) && provider) {
        const breaker = this.circuitBreakers.getBreaker(provider);
        const breakerCheck = breaker.canExecute();

        if (!breakerCheck.allowed) {
          return {
            id,
            type: "response",
            command: commandType,
            success: false,
            error: breakerCheck.reason,
          };
        }

        // Execute with circuit breaker tracking
        const startTime = Date.now();
        try {
          const routed = routeSessionCommand(session, command, (sid) => this.getSessionInfo(sid));
          if (routed === undefined) {
            return failResponse(`Unknown command type: ${commandType}`);
          }

          const response = await Promise.resolve(routed);
          const elapsedMs = Date.now() - startTime;

          if (response.success) {
            breaker.recordSuccess(elapsedMs);
          } else {
            // Distinguish between timeout and other errors
            const errorMsg = response.error?.toLowerCase() ?? "";
            if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
              breaker.recordFailure("timeout");
            } else {
              breaker.recordFailure("error");
            }
          }

          if (!response.success) {
            return failResponse(response.error ?? "Unknown error", response.command);
          }
          return response;
        } catch (error) {
          const elapsedMs = Date.now() - startTime;
          const errorMsg = error instanceof Error ? error.message.toLowerCase() : "";
          if (errorMsg.includes("timeout") || elapsedMs >= this.defaultCommandTimeoutMs) {
            breaker.recordFailure("timeout");
          } else {
            breaker.recordFailure("error");
          }
          throw error;
        }
      }

      // Non-LLM commands: route without circuit breaker
      const routed = routeSessionCommand(session, command, (sid) => this.getSessionInfo(sid));
      if (routed === undefined) {
        return failResponse(`Unknown command type: ${commandType}`);
      }

      const response = await Promise.resolve(routed);
      if (!response.success) {
        return failResponse(response.error ?? "Unknown error", response.command);
      }
      return response;
    } catch (error) {
      return failResponse(error instanceof Error ? error.message : String(error));
    }
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  private generateSessionId(): string {
    // Use crypto for collision-safe ID generation
    const timestamp = Date.now().toString(36);
    const random = crypto.randomUUID().split("-")[0];
    return `session-${timestamp}-${random}`;
  }
}
