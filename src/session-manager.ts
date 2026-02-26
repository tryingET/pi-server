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

/** Default timeout for session commands (5 minutes for LLM operations) */
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Default graceful shutdown timeout (30 seconds) */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30 * 1000;

/** Short command timeout (30 seconds) */
const SHORT_COMMAND_TIMEOUT_MS = 30 * 1000;

/** Commands that should have shorter timeout */
const SHORT_TIMEOUT_COMMANDS = new Set([
  "get_state",
  "get_messages",
  "get_available_models",
  "get_commands",
  "get_skills",
  "get_tools",
  "list_session_files",
  "get_session_stats",
  "get_fork_messages",
  "get_last_assistant_text",
  "get_context_usage",
  "set_session_name",
]);

/** Commands that should not use command timeout (cannot be safely cancelled) */
const NO_TIMEOUT_COMMANDS = new Set(["create_session"]);

/** Read-only session commands (do not advance sessionVersion on success). */
const READ_ONLY_SESSION_COMMANDS = new Set([
  "get_state",
  "get_messages",
  "get_available_models",
  "get_commands",
  "get_skills",
  "get_tools",
  "list_session_files",
  "get_session_stats",
  "get_fork_messages",
  "get_last_assistant_text",
  "get_context_usage",
  "switch_session",
]);

/** How long idempotency results are replayable (10 minutes). */
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/** Maximum number of retained command outcomes for dependency checks. */
const MAX_COMMAND_OUTCOMES = 2000;

/** Max time to wait for a dependency command to complete. */
const DEPENDENCY_WAIT_TIMEOUT_MS = 30 * 1000;

/**
 * Best-effort abort handlers for timed-out session commands.
 * Keeps timeout responses aligned with actual command cancellation.
 */
const TIMEOUT_ABORT_HANDLERS: Partial<
  Record<string, (session: AgentSession) => void | Promise<void>>
> = {
  prompt: (session) => session.abort(),
  steer: (session) => session.abort(),
  follow_up: (session) => session.abort(),
  compact: (session) => session.abortCompaction(),
  bash: (session) => session.abortBash(),
  new_session: (session) => session.abort(),
  switch_session_file: (session) => session.abort(),
  fork: (session) => session.abort(),
};

/**
 * Wrap a promise with a timeout.
 * Returns the promise result or throws on timeout.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  commandType: string,
  onTimeout?: () => void | Promise<void>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;

      Promise.resolve(onTimeout?.())
        .catch(() => {
          // Ignore cancellation hook errors; timeout response still returned.
        })
        .finally(() => {
          reject(new Error(`Command '${commandType}' timed out after ${timeoutMs}ms`));
        });
    }, timeoutMs);

    promise
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

interface CommandOutcomeRecord {
  commandId: string;
  commandType: string;
  laneKey: string;
  fingerprint: string;
  success: boolean;
  error?: string;
  response: RpcResponse;
  sessionVersion?: number;
  finishedAt: number;
}

interface InFlightCommandRecord {
  commandType: string;
  laneKey: string;
  fingerprint: string;
  promise: Promise<RpcResponse>;
}

interface IdempotencyCacheEntry {
  expiresAt: number;
  commandType: string;
  fingerprint: string;
  response: RpcResponse;
}

export interface SessionManagerRuntimeOptions {
  defaultCommandTimeoutMs?: number;
  shortCommandTimeoutMs?: number;
  dependencyWaitTimeoutMs?: number;
  idempotencyTtlMs?: number;
}

export class PiSessionManager {
  private sessions = new Map<string, AgentSession>();
  private sessionCreatedAt = new Map<string, Date>();
  private subscribers = new Set<Subscriber>();
  private unsubscribers = new Map<string, () => void>();
  private governor: ResourceGovernor;

  /** Deterministic per-lane command serialization tails. */
  private laneTails = new Map<string, Promise<void>>();
  /** Monotonic per-session version counter. */
  private sessionVersions = new Map<string, number>();
  /** In-flight commands by command id (for dependency waits and duplicate-id replay). */
  private commandInFlightById = new Map<string, InFlightCommandRecord>();
  /** Completed command outcomes (for dependency checks and duplicate-id replay). */
  private commandOutcomes = new Map<string, CommandOutcomeRecord>();
  /** Bounded insertion order to trim commandOutcomes memory. */
  private commandOutcomeOrder: string[] = [];
  /** Idempotency replay cache. */
  private idempotencyCache = new Map<string, IdempotencyCacheEntry>();
  /** Sequence for synthetic command IDs when client omits id. */
  private syntheticCommandSequence = 0;

  // Shutdown state (single source of truth - server.ts delegates to this)
  private isShuttingDown = false;
  private inFlightCommands = new Set<Promise<unknown>>();

  private readonly defaultCommandTimeoutMs: number;
  private readonly shortCommandTimeoutMs: number;
  private readonly dependencyWaitTimeoutMs: number;
  private readonly idempotencyTtlMs: number;

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
    this.idempotencyTtlMs =
      typeof options.idempotencyTtlMs === "number" && options.idempotencyTtlMs > 0
        ? options.idempotencyTtlMs
        : IDEMPOTENCY_TTL_MS;
  }

  /**
   * Get the resource governor for external checks (e.g., message size).
   */
  getGovernor(): ResourceGovernor {
    return this.governor;
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
    this.sessionVersions.clear();
    this.laneTails.clear();
    this.commandInFlightById.clear();
    this.commandOutcomes.clear();
    this.commandOutcomeOrder = [];
    this.idempotencyCache.clear();

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

  /**
   * Run a task in a deterministic serialized lane.
   */
  private async runOnLane<T>(laneKey: string, task: () => Promise<T>): Promise<T> {
    const previousTail = this.laneTails.get(laneKey) ?? Promise.resolve();

    let releaseCurrent: (() => void) | undefined;
    const currentTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    this.laneTails.set(
      laneKey,
      previousTail.then(
        () => currentTail,
        () => currentTail
      )
    );

    await previousTail.catch(() => {
      // Previous command failure should not break lane sequencing.
    });

    try {
      return await task();
    } finally {
      releaseCurrent?.();
      if (this.laneTails.get(laneKey) === currentTail) {
        this.laneTails.delete(laneKey);
      }
    }
  }

  private getLaneKey(command: RpcCommand): string {
    const sessionId = getSessionId(command);
    if (sessionId) return `session:${sessionId}`;
    return "server";
  }

  private getOrCreateCommandId(command: RpcCommand): string {
    const explicitId = getCommandId(command);
    if (explicitId) return explicitId;

    this.syntheticCommandSequence += 1;
    return `anon:${Date.now()}:${this.syntheticCommandSequence}`;
  }

  private getSessionVersion(sessionId: string): number | undefined {
    return this.sessionVersions.get(sessionId);
  }

  private trimCommandOutcomes(): void {
    while (this.commandOutcomeOrder.length > MAX_COMMAND_OUTCOMES) {
      const oldest = this.commandOutcomeOrder.shift();
      if (!oldest) break;
      this.commandOutcomes.delete(oldest);
    }
  }

  private storeCommandOutcome(outcome: CommandOutcomeRecord): void {
    const existed = this.commandOutcomes.has(outcome.commandId);
    this.commandOutcomes.set(outcome.commandId, outcome);

    if (!existed) {
      this.commandOutcomeOrder.push(outcome.commandId);
      this.trimCommandOutcomes();
    }
  }

  private cleanupIdempotencyCache(now = Date.now()): void {
    for (const [key, entry] of this.idempotencyCache) {
      if (entry.expiresAt <= now) {
        this.idempotencyCache.delete(key);
      }
    }
  }

  private buildIdempotencyCacheKey(command: RpcCommand, key: string): string {
    const sessionId = getSessionId(command) ?? "_server_";
    return `${sessionId}:${key}`;
  }

  private getCommandFingerprint(command: RpcCommand): string {
    const { id: _id, ...rest } = command;
    return JSON.stringify(rest);
  }

  private createCommandConflictResponse(
    id: string | undefined,
    commandType: string,
    conflictType: "id" | "idempotencyKey",
    value: string,
    originalType: string
  ): RpcResponse {
    return {
      id,
      type: "response",
      command: commandType,
      success: false,
      error: `Conflicting ${conflictType} '${value}': previously used for '${originalType}', now used for '${commandType}'`,
    };
  }

  private cloneResponseForRequest(
    response: RpcResponse,
    requestId: string | undefined
  ): RpcResponse {
    if (requestId === undefined) {
      const { id: _oldId, ...rest } = response;
      return { ...rest };
    }
    return { ...response, id: requestId };
  }

  private isSessionMutation(commandType: string): boolean {
    if (READ_ONLY_SESSION_COMMANDS.has(commandType)) return false;
    if (commandType === "extension_ui_response") return false;
    return true;
  }

  private applySessionVersion(command: RpcCommand, response: RpcResponse): RpcResponse {
    if (!response.success) return response;

    if (
      command.type === "create_session" &&
      response.command === "create_session" &&
      response.success
    ) {
      const createdSessionId = response.data.sessionId;
      this.sessionVersions.set(createdSessionId, 0);
      return { ...response, sessionVersion: 0 };
    }

    if (
      command.type === "delete_session" &&
      response.command === "delete_session" &&
      response.success
    ) {
      this.sessionVersions.delete(command.sessionId);
      return response;
    }

    const sessionId = getSessionId(command);
    if (!sessionId) return response;

    const current = this.sessionVersions.get(sessionId) ?? 0;
    const next = this.isSessionMutation(command.type) ? current + 1 : current;
    this.sessionVersions.set(sessionId, next);

    return { ...response, sessionVersion: next };
  }

  private async awaitDependencies(
    dependsOn: string[],
    laneKey: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    for (const dependencyId of dependsOn) {
      if (!dependencyId) {
        return { ok: false, error: "Dependency ID must be non-empty" };
      }

      const inFlight = this.commandInFlightById.get(dependencyId);
      if (inFlight) {
        if (inFlight.laneKey === laneKey) {
          return {
            ok: false,
            error: `Dependency '${dependencyId}' is queued in the same lane and cannot be awaited from this command`,
          };
        }

        try {
          const dependencyResponse = await withTimeout(
            inFlight.promise,
            this.dependencyWaitTimeoutMs,
            `dependsOn:${dependencyId}`
          );
          if (!dependencyResponse.success) {
            return {
              ok: false,
              error: `Dependency '${dependencyId}' failed: ${dependencyResponse.error ?? "unknown error"}`,
            };
          }
          continue;
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const completed = this.commandOutcomes.get(dependencyId);
      if (!completed) {
        return { ok: false, error: `Dependency '${dependencyId}' is unknown` };
      }

      if (!completed.success) {
        return {
          ok: false,
          error: `Dependency '${dependencyId}' failed: ${completed.error ?? "unknown error"}`,
        };
      }
    }

    return { ok: true };
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
    // Validate session ID
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

    // Check for duplicate (still possible race, but unlikely with valid IDs)
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    // Atomically reserve a session slot (prevents race conditions)
    if (!this.governor.tryReserveSessionSlot()) {
      throw new Error(`Session limit reached (${this.governor.getConfig().maxSessions} sessions)`);
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

      // Re-check duplicate after async creation to close race window
      if (this.sessions.has(sessionId)) {
        session.dispose();
        throw new Error(`Session ${sessionId} already exists`);
      }

      this.sessions.set(sessionId, session);
      this.sessionCreatedAt.set(sessionId, new Date());
      this.sessionVersions.set(sessionId, 0);
      // Record heartbeat (session count already incremented by tryReserveSessionSlot)
      this.governor.recordHeartbeat(sessionId);

      // Subscribe to all events from this session
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        this.broadcastEvent(sessionId, event);
      });
      this.unsubscribers.set(sessionId, unsubscribe);

      return this.getSessionInfo(sessionId)!;
    } catch (error) {
      // Release the slot if session creation failed
      this.governor.releaseSessionSlot();
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Cancel any pending extension UI requests for this session
    this.extensionUI.cancelSessionRequests(sessionId);

    // Remove from maps first to prevent new operations
    this.sessions.delete(sessionId);
    this.sessionCreatedAt.delete(sessionId);
    this.sessionVersions.delete(sessionId);
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
    const commandId = this.getOrCreateCommandId(command);
    const dependsOn = getCommandDependsOn(command) ?? [];
    const ifSessionVersion = getCommandIfSessionVersion(command);
    const idempotencyKey = getCommandIdempotencyKey(command);
    const laneKey = this.getLaneKey(command);
    const fingerprint = this.getCommandFingerprint(command);

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

    this.cleanupIdempotencyCache();

    this.broadcastCommandLifecycle("command_accepted", {
      commandId,
      commandType,
      sessionId,
      dependsOn,
      ifSessionVersion,
      idempotencyKey,
    });

    if (idempotencyKey) {
      const cacheKey = this.buildIdempotencyCacheKey(command, idempotencyKey);
      const cached = this.idempotencyCache.get(cacheKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          const conflict = this.createCommandConflictResponse(
            id,
            commandType,
            "idempotencyKey",
            idempotencyKey,
            cached.commandType
          );
          this.broadcastCommandLifecycle("command_finished", {
            commandId,
            commandType,
            sessionId,
            dependsOn,
            ifSessionVersion,
            idempotencyKey,
            success: false,
            error: conflict.error,
          });
          return conflict;
        }

        const replayed = this.cloneResponseForRequest(
          {
            ...cached.response,
            replayed: true,
          },
          id
        );
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
    }

    if (id) {
      const completed = this.commandOutcomes.get(id);
      if (completed) {
        if (completed.fingerprint !== fingerprint) {
          const conflict = this.createCommandConflictResponse(
            id,
            commandType,
            "id",
            id,
            completed.commandType
          );
          this.broadcastCommandLifecycle("command_finished", {
            commandId,
            commandType,
            sessionId,
            dependsOn,
            ifSessionVersion,
            idempotencyKey,
            success: false,
            error: conflict.error,
          });
          return conflict;
        }

        const replayed = this.cloneResponseForRequest(
          { ...completed.response, replayed: true },
          id
        );
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

      const inFlightDuplicate = this.commandInFlightById.get(id);
      if (inFlightDuplicate) {
        if (inFlightDuplicate.fingerprint !== fingerprint) {
          const conflict = this.createCommandConflictResponse(
            id,
            commandType,
            "id",
            id,
            inFlightDuplicate.commandType
          );
          this.broadcastCommandLifecycle("command_finished", {
            commandId,
            commandType,
            sessionId,
            dependsOn,
            ifSessionVersion,
            idempotencyKey,
            success: false,
            error: conflict.error,
          });
          return conflict;
        }

        const duplicateResponse = await inFlightDuplicate.promise;
        const replayed = this.cloneResponseForRequest({ ...duplicateResponse, replayed: true }, id);
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
    }
    const commandExecution = this.runOnLane<RpcResponse>(
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
          const dependencyResult = await this.awaitDependencies(dependsOn, laneKey);
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
          const current = this.getSessionVersion(sessionId);
          if (current === undefined) {
            return {
              id,
              type: "response",
              command: commandType,
              success: false,
              error: `Session ${sessionId} not found for ifSessionVersion=${ifSessionVersion}`,
            };
          }
          if (current !== ifSessionVersion) {
            return {
              id,
              type: "response",
              command: commandType,
              success: false,
              error: `Session version mismatch: expected ${ifSessionVersion}, got ${current}`,
            };
          }
        }

        const rawResponse = await this.executeCommandInternal(command, id, commandType);
        return this.applySessionVersion(command, rawResponse);
      }
    );

    if (id) {
      const inFlightRecord: InFlightCommandRecord = {
        commandType,
        laneKey,
        fingerprint,
        promise: commandExecution,
      };
      this.commandInFlightById.set(id, inFlightRecord);
      commandExecution
        .then((finalResponse) => {
          this.storeCommandOutcome({
            commandId: id,
            commandType,
            laneKey,
            fingerprint,
            success: finalResponse.success,
            error: finalResponse.success ? undefined : finalResponse.error,
            response: finalResponse,
            sessionVersion: finalResponse.sessionVersion,
            finishedAt: Date.now(),
          });
        })
        .finally(() => {
          if (this.commandInFlightById.get(id) === inFlightRecord) {
            this.commandInFlightById.delete(id);
          }
        });
    }

    if (idempotencyKey) {
      const cacheKey = this.buildIdempotencyCacheKey(command, idempotencyKey);
      commandExecution.then((response) => {
        this.idempotencyCache.set(cacheKey, {
          expiresAt: Date.now() + this.idempotencyTtlMs,
          commandType,
          fingerprint,
          response,
        });
      });
    }

    this.registerInFlightCommand(commandExecution);

    const timeoutMs = this.getCommandTimeoutMs(commandType);
    let response: RpcResponse;

    try {
      if (timeoutMs === null) {
        response = await commandExecution;
      } else {
        response = await withTimeout(commandExecution, timeoutMs, commandType, () =>
          this.abortTimedOutCommand(command)
        );
      }
    } catch (error) {
      response = {
        id,
        type: "response",
        command: commandType,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (id) {
      this.storeCommandOutcome({
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
   * Resolve timeout policy for a command.
   */
  private getCommandTimeoutMs(commandType: string): number | null {
    if (NO_TIMEOUT_COMMANDS.has(commandType)) {
      return null;
    }

    return SHORT_TIMEOUT_COMMANDS.has(commandType)
      ? this.shortCommandTimeoutMs
      : this.defaultCommandTimeoutMs;
  }

  /**
   * Best-effort cancellation for timed-out commands.
   */
  private async abortTimedOutCommand(command: RpcCommand): Promise<void> {
    const sessionId = getSessionId(command);
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    const abortHandler = TIMEOUT_ABORT_HANDLERS[command.type];
    if (!abortHandler) return;

    try {
      await Promise.resolve(abortHandler(session));
    } catch (error) {
      console.error(
        `[timeout] Failed to abort timed out command '${command.type}' for session ${sessionId}:`,
        error
      );
    }
  }

  /**
   * Internal command execution (called after tracking).
   */
  private async executeCommandInternal(
    command: RpcCommand,
    id: string | undefined,
    commandType: string
  ): Promise<RpcResponse> {
    const rateLimitKey = getSessionId(command) ?? "_server_";
    let rateLimitCharged = false;

    const failResponse = (error: string, responseCommand = commandType): RpcResponse => {
      if (rateLimitCharged) {
        this.governor.refundCommand(rateLimitKey);
        rateLimitCharged = false;
      }
      return {
        id,
        type: "response",
        command: responseCommand,
        success: false,
        error,
      };
    };

    try {
      // Rate limiting AFTER validation - use sessionId for session commands, "_server_" for server commands
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
      rateLimitCharged = true;

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

        case "get_metrics":
          return {
            id,
            type: "response",
            command: "get_metrics",
            success: true,
            data: this.governor.getMetrics(),
          };

        case "health_check": {
          const health = this.governor.isHealthy();
          return {
            id,
            type: "response",
            command: "health_check",
            success: true,
            data: health,
          };
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

      // Route to command handler
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
