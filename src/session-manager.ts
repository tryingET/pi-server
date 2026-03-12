/**
 * Session Manager - owns session lifecycle, command execution, and subscriber maps.
 *
 * RESPONSIBILITIES (per AGENTS.md):
 * - Orchestration: coordinates stores, engines, sessions
 * - Session lifecycle (create, delete, list, load)
 * - Subscriber and event broadcast management
 * - Command execution pipeline (tracking, rate limiting, replay)
 *
 * DOES NOT:
 * - Handle server commands directly (delegates to server-command-handlers.ts)
 * - Handle session commands directly (delegates to command-router.ts)
 * - Mutate state directly (delegates to stores)
 */

import path from "path";
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
  StartupRecoveryData,
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
import {
  routeServerCommand,
  executeLLMCommand,
  executeBashCommand,
  type ServerCommandContext,
} from "./server-command-handlers.js";
import { ExtensionUIManager } from "./extension-ui.js";
import { createServerUIContext } from "./server-ui-context.js";
import {
  validateCommand,
  formatValidationErrors,
  validateSessionFileAccess,
} from "./validation.js";
import { ResourceGovernor, DEFAULT_CONFIG } from "./resource-governor.js";
import {
  CommandReplayStore,
  type InFlightCommandRecord,
  SYNTHETIC_ID_PREFIX,
} from "./command-replay-store.js";
import { SessionVersionStore } from "./session-version-store.js";
import { CommandExecutionEngine } from "./command-execution-engine.js";
import { getRateLimitTarget } from "./command-classification.js";
import { SessionLockManager } from "./session-lock-manager.js";
import { SessionStore, type StoredSessionInfo } from "./session-store.js";
import { CircuitBreakerManager, type CircuitBreakerConfig } from "./circuit-breaker.js";
import { BashCircuitBreaker, type BashCircuitBreakerConfig } from "./bash-circuit-breaker.js";
import {
  DurableCommandJournal,
  MAX_COMMAND_HISTORY_LIMIT,
  type CommandHistoryQuery,
  type CommandJournalRecoverySummary,
  type DurableCommandJournalOptions,
} from "./command-journal.js";

/** Default timeout for session commands (5 minutes for LLM operations) */
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Default graceful shutdown timeout (30 seconds) */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30 * 1000;

/** Short command timeout (30 seconds) */
const SHORT_COMMAND_TIMEOUT_MS = 30 * 1000;

/** Max time to wait for a dependency command to complete. */
const DEPENDENCY_WAIT_TIMEOUT_MS = 30 * 1000;

/** Max time to wait for durable journal startup initialization. */
const DEFAULT_DURABLE_INIT_TIMEOUT_MS = 5 * 1000;

/** Max entries returned per list field in get_startup_recovery. */
const STARTUP_RECOVERY_MAX_ITEMS = 100;

type DurableInitState = "disabled" | "pending" | "ready" | "failed" | "timed_out";

interface StartupRecoverySnapshot {
  enabled: boolean;
  initialized: boolean;
  journalPath: string;
  schemaVersion: number;
  entriesScanned: number;
  malformedEntries: number;
  unsupportedVersionEntries: number;
  recoveredOutcomes: number;
  recoveredOutcomeIds: string[];
  recoveredOutcomeIdsTruncated: boolean;
  recoveredInFlightFailures: number;
  recoveredInFlight: Array<{
    commandId: string;
    commandType: string;
    laneKey: string;
    lastPhase: "command_accepted" | "command_started";
    reason: string;
  }>;
  recoveredInFlightTruncated: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Global mutex for AgentSession creation while process.env is temporarily sanitized.
 *
 * Root cause: createAgentSession currently reads process-global environment.
 * Two concurrent calls that both delete/restore npm_config_prefix can otherwise
 * interleave and reintroduce the very env leakage we are trying to prevent.
 */
let sanitizedAgentSessionCreationTail: Promise<void> = Promise.resolve();

/**
 * npm env keys inherited from npm scripts that can hijack global installs.
 * When present (e.g. npm_config_prefix=<project>), createAgentSession's
 * package manager may install "global" packages into the project directory.
 */
const SANITIZED_NPM_ENV_KEYS = ["npm_config_prefix", "NPM_CONFIG_PREFIX"] as const;

export interface SessionManagerRuntimeOptions {
  defaultCommandTimeoutMs?: number;
  shortCommandTimeoutMs?: number;
  dependencyWaitTimeoutMs?: number;
  idempotencyTtlMs?: number;
  /** Server version for session metadata tracking */
  serverVersion?: string;
  /** Circuit breaker configuration (optional, uses defaults if not provided) */
  circuitBreakerConfig?: Partial<Omit<CircuitBreakerConfig, "providerName">>;
  /** Bash circuit breaker configuration (optional, uses defaults if not provided) */
  bashCircuitBreakerConfig?: Partial<BashCircuitBreakerConfig>;
  /** Durable command journal options (Level 4 foundation, feature-flagged) */
  durableJournal?: DurableCommandJournalOptions;
  /** Timeout for durable journal startup initialization attempts. */
  durableInitTimeoutMs?: number;
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
  /** Circuit breaker for bash commands. */
  private bashCircuitBreaker: BashCircuitBreaker;
  /** Durable command journal (Level 4 foundation, feature-flagged). */
  private commandJournal: DurableCommandJournal;
  /** Bounded startup recovery snapshot derived from durable journal rehydration. */
  private startupRecoverySnapshot: StartupRecoverySnapshot | null = null;
  /** One-time initialization promise for durable journal startup rehydration. */
  private durableInitPromise: Promise<void> | null = null;
  /** Durable init lifecycle state (for get_startup_recovery observability). */
  private durableInitState: DurableInitState = "pending";
  /** Last durable initialization error, if any. */
  private durableInitError: string | null = null;

  // Shutdown state (single source of truth - server.ts delegates to this)
  private isShuttingDown = false;
  /** Runtime has been fully torn down; late completions must not mutate stores. */
  private runtimeDisposed = false;
  private inFlightCommands = new Set<Promise<unknown>>();

  // Periodic cleanup timers
  private sessionExpirationTimer: NodeJS.Timeout | null = null;

  private readonly defaultCommandTimeoutMs: number;
  private readonly shortCommandTimeoutMs: number;
  private readonly dependencyWaitTimeoutMs: number;
  private readonly durableInitTimeoutMs: number;

  // Extension UI request tracking
  private extensionUI = new ExtensionUIManager((sessionId: string, event: AgentSessionEvent) =>
    this.broadcastEvent(sessionId, event)
  );

  /** Optional memory metrics provider (set by server for ADR-0016) */
  private memoryMetricsProvider: (() => Record<string, unknown> | undefined) | null = null;
  /** Optional debug logger (wired by server logger at debug level). */
  private debugLogger: ((message: string, context?: Record<string, unknown>) => void) | null = null;
  /** Ensures npm prefix sanitization diagnostic is emitted at most once per process. */
  private npmSanitizationDiagnosticLogged = false;

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
    this.durableInitTimeoutMs =
      typeof options.durableInitTimeoutMs === "number" && options.durableInitTimeoutMs > 0
        ? options.durableInitTimeoutMs
        : DEFAULT_DURABLE_INIT_TIMEOUT_MS;

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
    this.bashCircuitBreaker = new BashCircuitBreaker(options.bashCircuitBreakerConfig);
    this.commandJournal = new DurableCommandJournal({
      serverVersion: options.serverVersion,
      ...options.durableJournal,
    });
    this.durableInitState = this.commandJournal.isEnabled() ? "pending" : "disabled";
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

  /**
   * Get the bash circuit breaker for external access.
   */
  getBashCircuitBreaker(): BashCircuitBreaker {
    return this.bashCircuitBreaker;
  }

  /**
   * One-time startup initialization.
   * Rehydrates durable command outcomes when the journal feature flag is enabled.
   */
  async initialize(): Promise<void> {
    await this.ensureDurableJournalInitialized();
  }

  private async waitForDurableInitWithTimeout(promise: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | null = null;

    try {
      await Promise.race([
        promise,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Durable journal initialization timed out after ${this.durableInitTimeoutMs}ms`
              )
            );
          }, this.durableInitTimeoutMs);
          if (timer.unref) {
            timer.unref();
          }
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Ensure durable journal recovery has completed (idempotent and bounded).
   */
  private async ensureDurableJournalInitialized(): Promise<void> {
    if (!this.commandJournal.isEnabled()) {
      this.durableInitState = "disabled";
      this.durableInitError = null;
      return;
    }

    // Runtime fail-closed policy can transition durable state to failed after startup.
    // When that happens, non-observability commands must fail closed.
    if (this.durableInitState === "failed" && this.durableInitError) {
      throw new Error(this.durableInitError);
    }

    if (this.durableInitState === "ready") {
      return;
    }

    if (!this.durableInitPromise) {
      this.durableInitState = "pending";
      this.durableInitError = null;

      const initPromise = (async () => {
        try {
          const recovery = await this.commandJournal.initialize();

          for (const outcome of recovery.recoveredOutcomes) {
            this.replayStore.storeCommandOutcome(outcome);
          }

          this.startupRecoverySnapshot = this.createStartupRecoverySnapshot(recovery);
          this.durableInitState = "ready";
          this.durableInitError = null;

          if (
            recovery.recoveredOutcomes.length > 0 ||
            recovery.recoveredInFlightFailures > 0 ||
            recovery.malformedEntries > 0
          ) {
            this.debugLogger?.("Durable command journal recovery completed", {
              journalPath: recovery.journalPath,
              entriesScanned: recovery.entriesScanned,
              malformedEntries: recovery.malformedEntries,
              unsupportedVersionEntries: recovery.unsupportedVersionEntries,
              recoveredOutcomes: recovery.recoveredOutcomes.length,
              recoveredInFlightFailures: recovery.recoveredInFlightFailures,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.durableInitState = "failed";
          this.durableInitError = message;
          throw error;
        }
      })();

      // Guard against unhandled rejections when callers timeout before init settles.
      initPromise.catch(() => {});
      this.durableInitPromise = initPromise;
    }

    try {
      await this.waitForDurableInitWithTimeout(this.durableInitPromise);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("timed out")) {
        this.durableInitState = "timed_out";
      } else if (this.durableInitState !== "failed") {
        this.durableInitState = "failed";
      }
      this.durableInitError = message;
      throw error;
    }
  }

  private createStartupRecoverySnapshot(
    recovery: CommandJournalRecoverySummary
  ): StartupRecoverySnapshot {
    const recoveredOutcomeIds = recovery.recoveredOutcomes
      .slice(0, STARTUP_RECOVERY_MAX_ITEMS)
      .map((outcome) => outcome.commandId);

    const recoveredInFlight = recovery.recoveredInFlight
      .slice(0, STARTUP_RECOVERY_MAX_ITEMS)
      .map((item) => ({
        commandId: item.commandId,
        commandType: item.commandType,
        laneKey: item.laneKey,
        lastPhase: item.lastPhase,
        reason: item.reason,
      }));

    return {
      enabled: recovery.enabled,
      initialized: true,
      journalPath: recovery.journalPath,
      schemaVersion: recovery.schemaVersion,
      entriesScanned: recovery.entriesScanned,
      malformedEntries: recovery.malformedEntries,
      unsupportedVersionEntries: recovery.unsupportedVersionEntries,
      recoveredOutcomes: recovery.recoveredOutcomes.length,
      recoveredOutcomeIds,
      recoveredOutcomeIdsTruncated: recovery.recoveredOutcomes.length > STARTUP_RECOVERY_MAX_ITEMS,
      recoveredInFlightFailures: recovery.recoveredInFlightFailures,
      recoveredInFlight,
      recoveredInFlightTruncated: recovery.recoveredInFlight.length > STARTUP_RECOVERY_MAX_ITEMS,
    };
  }

  private markDurableJournalRuntimeFailure(message: string): void {
    this.durableInitState = "failed";
    this.durableInitError = message;
  }

  /**
   * Persist a terminal fail-closed outcome without applying normal redaction hooks.
   * This preserves explicit-ID determinism when command_finished append fails.
   */
  private appendFailClosedTerminalFailureToJournal(input: {
    commandId: string;
    commandType: string;
    laneKey: string;
    fingerprint: string;
    explicitId: boolean;
    sessionId?: string;
    dependsOn?: string[];
    ifSessionVersion?: number;
    idempotencyKey?: string;
    success: boolean;
    error?: string;
    sessionVersion?: number;
    replayed?: boolean;
    timedOut?: boolean;
    response: RpcResponse;
  }): { ok: boolean; error?: string } {
    if (!this.commandJournal.isEnabled() || !this.commandJournal.getStats().initialized) {
      return { ok: false, error: "Durable journal fallback unavailable" };
    }

    try {
      this.commandJournal.appendFailClosedTerminalFailure(input);
      return { ok: true };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Unknown fallback append failure: ${String(error)}`;
      console.error(
        "[SessionManager] Failed to append fail-closed fallback terminal outcome:",
        error
      );
      return { ok: false, error: message };
    }
  }

  /**
   * Append command lifecycle transition to the durable journal.
   *
   * - best_effort: append errors are logged and command flow continues
   * - fail_closed: append errors transition durable state to failed and caller can fail command
   */
  private appendCommandLifecycleToJournal(input: {
    phase: "command_accepted" | "command_started" | "command_finished";
    commandId: string;
    commandType: string;
    laneKey: string;
    fingerprint: string;
    explicitId: boolean;
    sessionId?: string;
    dependsOn?: string[];
    ifSessionVersion?: number;
    idempotencyKey?: string;
    success?: boolean;
    error?: string;
    sessionVersion?: number;
    replayed?: boolean;
    timedOut?: boolean;
    response?: RpcResponse;
  }): { ok: boolean; failClosed: boolean; error?: string } {
    if (!this.commandJournal.isEnabled()) {
      return { ok: true, failClosed: false };
    }

    // Journal append is only valid after successful initialization.
    // This keeps get_startup_recovery available even when durable init failed
    // without noisy appendLifecycle("called before initialize") errors.
    if (!this.commandJournal.getStats().initialized) {
      return { ok: true, failClosed: false };
    }

    const failClosed = this.commandJournal.getAppendFailurePolicy() === "fail_closed";

    try {
      this.commandJournal.appendLifecycle(input);
      return { ok: true, failClosed: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const message = `Durable journal append failed during ${input.phase} for command '${input.commandId}': ${errorMessage}`;

      console.error(`[SessionManager] ${message}`, error);

      if (failClosed) {
        this.markDurableJournalRuntimeFailure(message);
      }

      return {
        ok: false,
        failClosed,
        error: message,
      };
    }
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
   * Set the memory metrics provider for ADR-0016 metrics system.
   * Called by PiServer to provide access to MemorySink metrics.
   */
  setMemoryMetricsProvider(provider: () => Record<string, unknown> | undefined): void {
    this.memoryMetricsProvider = provider;
  }

  /**
   * Set optional debug logger used for low-noise diagnostics.
   * PiServer wires this to logger.debug(), so output is level-gated.
   */
  setDebugLogger(
    logger: ((message: string, context?: Record<string, unknown>) => void) | null
  ): void {
    this.debugLogger = logger;
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
        this.abortAllSessions();
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
   * Best-effort abort of active session work during shutdown escalation.
   */
  abortAllSessions(): void {
    for (const session of this.sessions.values()) {
      try {
        session.abort();
      } catch {
        // Ignore abort failures during shutdown escalation.
      }
      try {
        session.abortCompaction();
      } catch {
        // Ignore abort failures during shutdown escalation.
      }
      try {
        session.abortBash();
      } catch {
        // Ignore abort failures during shutdown escalation.
      }
      try {
        session.abortRetry();
      } catch {
        // Ignore abort failures during shutdown escalation.
      }
    }
  }

  /**
   * Mark the runtime as fully disposed so late completions stop mutating state.
   */
  markRuntimeDisposed(): void {
    this.runtimeDisposed = true;
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
      let removedFromGovernor = false;
      try {
        // Get session before removing
        const session = this.sessions.get(sessionId);

        // Remove from maps first
        this.sessions.delete(sessionId);
        this.sessionCreatedAt.delete(sessionId);
        this.versionStore.delete(sessionId);
        this.extensionUI.cancelSessionRequests(sessionId);
        this.governor.unregisterSession(sessionId);
        removedFromGovernor = true;

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
        if (!removedFromGovernor && this.governor.getSessionCount() > 0) {
          this.governor.cleanupStaleData(new Set(this.sessions.keys()));
        }
      }
    }

    for (const subscriber of this.subscribers) {
      subscriber.subscribedSessions.clear();
    }

    // Clear runtime registries
    this.versionStore.clear();
    this.executionEngine.clear();
    this.replayStore.clear();
    this.lockManager.clear();

    // Clear governor state
    this.governor.cleanupStaleData(new Set());

    // Release durable journal resources (e.g., single-writer lock file).
    this.commandJournal.dispose();

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

  private buildSessionInfoFromSession(
    sessionId: string,
    session: AgentSession,
    createdAt: Date
  ): SessionInfo {
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

  /**
   * Resolve the runtime cwd used when loading an existing session file.
   * Falls back to the active server cwd if the persisted source cwd is missing,
   * malformed, or not an absolute path.
   */
  private resolveLoadSessionRuntimeCwd(sourceCwd: string | undefined): string {
    if (
      typeof sourceCwd === "string" &&
      sourceCwd.trim().length > 0 &&
      path.isAbsolute(sourceCwd)
    ) {
      return sourceCwd;
    }
    return process.cwd();
  }

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

    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let releaseSessionSlotOnFailure = false;
    let metadataSaved = false;

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
      releaseSessionSlotOnFailure = true;

      ({ session } = await this.createAgentSessionWithSanitizedNpmEnv({
        cwd: cwd ?? process.cwd(),
      }));

      // Wire extension UI before exposing the session to callers.
      await session.bindExtensions({
        uiContext: createServerUIContext(sessionId, this.extensionUI, (sid, event) =>
          this.broadcastEvent(sid, event)
        ),
      });

      // Final check still under lock - handles edge case of session creation side effects
      if (this.sessions.has(sessionId)) {
        throw new Error(`Session ${sessionId} already exists`);
      }

      if (!session.sessionFile) {
        throw new Error("Session created without session file - cannot persist");
      }

      const createdAt = new Date();
      const sessionInfo = this.buildSessionInfoFromSession(sessionId, session, createdAt);

      // Persist metadata BEFORE publishing the live session into runtime maps.
      await this.sessionStore.save({
        sessionId,
        sessionFile: session.sessionFile,
        cwd: cwd ?? process.cwd(),
        createdAt: sessionInfo.createdAt,
        modelId: session.model?.id,
      });
      metadataSaved = true;

      // Subscribe and then commit the session into runtime state.
      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        this.broadcastEvent(sessionId, event);
      });
      this.sessions.set(sessionId, session);
      this.sessionCreatedAt.set(sessionId, createdAt);
      this.versionStore.initialize(sessionId);
      this.governor.recordHeartbeat(sessionId);
      this.unsubscribers.set(sessionId, unsubscribe);

      releaseSessionSlotOnFailure = false;
      return sessionInfo;
    } catch (error) {
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (unsubscribeError) {
          console.error(`[createSession] Failed to unsubscribe during rollback:`, unsubscribeError);
        }
      }
      this.unsubscribers.delete(sessionId);
      this.sessions.delete(sessionId);
      this.sessionCreatedAt.delete(sessionId);
      this.versionStore.delete(sessionId);
      this.extensionUI.cancelSessionRequests(sessionId);

      if (metadataSaved) {
        try {
          await this.sessionStore.delete(sessionId);
        } catch (rollbackError) {
          console.error(
            `[createSession] Failed to roll back persisted metadata for ${sessionId}:`,
            rollbackError
          );
        }
      }

      if (session) {
        try {
          session.dispose();
        } catch (disposeError) {
          console.error(`[createSession] Failed to dispose rolled-back session:`, disposeError);
        }
      }

      if (releaseSessionSlotOnFailure) {
        this.governor.releaseSessionSlot();
        this.governor.cleanupStaleData(new Set(this.sessions.keys()));
      }

      throw error;
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

      // Remove persisted metadata first so a reported delete failure does not
      // leave runtime and durable state disagreeing about whether the session
      // still exists.
      await this.sessionStore.delete(sessionId);

      // Cancel any pending extension UI requests for this session
      this.extensionUI.cancelSessionRequests(sessionId);

      // Remove from maps first to prevent new operations
      this.sessions.delete(sessionId);
      this.sessionCreatedAt.delete(sessionId);
      this.versionStore.delete(sessionId);
      this.governor.unregisterSession(sessionId);

      // Clean up stale governor data for this session
      this.governor.cleanupStaleData(new Set(this.sessions.keys()));

      const cleanupErrors: string[] = [];

      // Unsubscribe from events
      const unsubscribe = this.unsubscribers.get(sessionId);
      if (unsubscribe) {
        this.unsubscribers.delete(sessionId);
        try {
          unsubscribe();
        } catch (error) {
          console.error(`[deleteSession] Failed to unsubscribe:`, error);
          cleanupErrors.push(
            error instanceof Error
              ? `unsubscribe: ${error.message}`
              : `unsubscribe: ${String(error)}`
          );
        }
      }

      // Dispose the session
      try {
        session.dispose();
      } catch (error) {
        console.error(`[deleteSession] Failed to dispose session:`, error);
        cleanupErrors.push(
          error instanceof Error ? `dispose: ${error.message}` : `dispose: ${String(error)}`
        );
      }

      // Remove this session from all subscriber subscriptions
      for (const subscriber of this.subscribers) {
        subscriber.subscribedSessions.delete(sessionId);
      }

      if (cleanupErrors.length > 0) {
        throw new Error(
          `Session ${sessionId} deleted from durable state but runtime cleanup failed (${cleanupErrors.join("; ")})`
        );
      }
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
   *
   * Security: sessionPath must be under an allowed directory to prevent path traversal.
   */
  async loadSession(sessionId: string, sessionPath: string): Promise<SessionInfo> {
    // Validate session ID
    const sessionIdError = this.governor.validateSessionId(sessionId);
    if (sessionIdError) {
      throw new Error(sessionIdError);
    }

    // Validate session path (prevents path traversal, outsider paths, and file clobbering)
    const sessionPathError = validateSessionFileAccess(sessionPath, {
      cwd: process.cwd(),
      requireExistingFile: true,
      requireSessionHeader: true,
    });
    if (sessionPathError) {
      throw new Error(sessionPathError);
    }

    const persistedFileMetadata = await this.sessionStore.readSessionFileMetadata(sessionPath);

    // Acquire lock for this session ID
    const lock = await this.lockManager.acquire(sessionId, "loadSession");

    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let releaseSessionSlotOnFailure = false;
    let metadataSaved = false;

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
      releaseSessionSlotOnFailure = true;

      // Create session using the source session's cwd when available.
      ({ session } = await this.createAgentSessionWithSanitizedNpmEnv({
        cwd: this.resolveLoadSessionRuntimeCwd(persistedFileMetadata.cwd),
      }));

      // Switch to the specified session file
      const switched = await session.switchSession(sessionPath);
      if (!switched) {
        throw new Error(`Failed to load session from ${sessionPath}`);
      }

      // Wire extension UI before exposing the session.
      await session.bindExtensions({
        uiContext: createServerUIContext(sessionId, this.extensionUI, (sid, event) =>
          this.broadcastEvent(sid, event)
        ),
      });

      // Final check still under lock
      if (this.sessions.has(sessionId)) {
        throw new Error(`Session ${sessionId} already exists`);
      }

      if (!session.sessionFile) {
        throw new Error("Session loaded without session file - cannot persist metadata");
      }

      const createdAt = new Date();
      const sessionInfo = this.buildSessionInfoFromSession(sessionId, session, createdAt);

      // Persist metadata BEFORE publishing runtime visibility.
      await this.sessionStore.save({
        sessionId,
        sessionFile: session.sessionFile,
        cwd: persistedFileMetadata.cwd,
        createdAt: sessionInfo.createdAt,
        modelId: session.model?.id,
        sessionName: session.sessionName,
      });
      metadataSaved = true;

      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        this.broadcastEvent(sessionId, event);
      });
      this.sessions.set(sessionId, session);
      this.sessionCreatedAt.set(sessionId, createdAt);
      this.versionStore.initialize(sessionId);
      this.governor.recordHeartbeat(sessionId);
      this.unsubscribers.set(sessionId, unsubscribe);

      releaseSessionSlotOnFailure = false;
      return sessionInfo;
    } catch (error) {
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (unsubscribeError) {
          console.error(`[loadSession] Failed to unsubscribe during rollback:`, unsubscribeError);
        }
      }
      this.unsubscribers.delete(sessionId);
      this.sessions.delete(sessionId);
      this.sessionCreatedAt.delete(sessionId);
      this.versionStore.delete(sessionId);
      this.extensionUI.cancelSessionRequests(sessionId);

      if (metadataSaved) {
        try {
          await this.sessionStore.delete(sessionId);
        } catch (rollbackError) {
          console.error(
            `[loadSession] Failed to roll back persisted metadata for ${sessionId}:`,
            rollbackError
          );
        }
      }

      if (session) {
        try {
          session.dispose();
        } catch (disposeError) {
          console.error(`[loadSession] Failed to dispose rolled-back session:`, disposeError);
        }
      }

      if (releaseSessionSlotOnFailure) {
        this.governor.releaseSessionSlot();
        this.governor.cleanupStaleData(new Set(this.sessions.keys()));
      }

      throw error;
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

    // Clean up stale bash circuit breakers
    const staleBashBreakersRemoved = this.bashCircuitBreaker.cleanupStale();
    if (staleBashBreakersRemoved > 0) {
      console.error(
        `[SessionManager] Cleaned up ${staleBashBreakersRemoved} stale bash circuit breakers`
      );
    }

    // Level 4.4 scaffold: periodic durable journal retention/compaction.
    if (this.commandJournal.isEnabled() && this.commandJournal.hasRetentionPolicy()) {
      try {
        const compaction = this.commandJournal.compactNow();
        if (compaction.ran && compaction.droppedEntries > 0) {
          this.debugLogger?.("Durable command journal compaction completed", {
            droppedEntries: compaction.droppedEntries,
            entriesBefore: compaction.entriesBefore,
            entriesAfter: compaction.entriesAfter,
            bytesBefore: compaction.bytesBefore,
            bytesAfter: compaction.bytesAfter,
          });
        }
      } catch (error) {
        console.error("[SessionManager] Durable journal compaction failed:", error);
      }
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
  // COMMAND EXECUTION CONTEXT
  // ==========================================================================

  /**
   * Create the command execution context for server command handlers.
   * This is the NEXUS seam - provides everything handlers need without
   * direct coupling to SessionManager internals.
   */
  private createCommandContext(principal?: string): ServerCommandContext {
    return {
      principal,
      getSession: (sessionId: string) => this.sessions.get(sessionId),
      getSessionInfo: (sessionId: string) => this.getSessionInfo(sessionId),
      listSessions: () => this.listSessions(),
      createSession: (sessionId: string, cwd?: string) => this.createSession(sessionId, cwd),
      deleteSession: (sessionId: string) => this.deleteSession(sessionId),
      loadSession: (sessionId: string, sessionPath: string) =>
        this.loadSession(sessionId, sessionPath),
      listStoredSessions: () => this.listStoredSessions(),
      getMetrics: () => this.buildMetricsResponse(),
      getMemoryMetrics: () => this.memoryMetricsProvider?.(),
      getHealth: () => this.buildHealthResponse(),
      getStartupRecovery: () => this.buildStartupRecoveryResponse(),
      getCommandHistory: (query) => this.buildCommandHistoryResponse(query),
      handleUIResponse: (command) =>
        this.extensionUI.handleUIResponse({
          id: command.id,
          sessionId: command.sessionId,
          type: "extension_ui_response",
          requestId: command.requestId,
          response: command.response,
        }),
      routeSessionCommand: (session, command, getSessionInfo) =>
        routeSessionCommand(session, command, getSessionInfo),
      generateSessionId: () => this.generateSessionId(),
      recordHeartbeat: (sessionId: string) => this.governor.recordHeartbeat(sessionId),
      getCircuitBreakers: () => ({
        hasOpenCircuit: () => this.circuitBreakers.hasOpenCircuit(),
        getBreaker: (provider: string) => {
          const breaker = this.circuitBreakers.getBreaker(provider);
          return {
            canExecute: () => breaker.canExecute(),
            recordSuccess: (elapsedMs: number) => breaker.recordSuccess(elapsedMs),
            recordFailure: (type: "timeout" | "error") => breaker.recordFailure(type),
          };
        },
      }),
      getBashCircuitBreaker: () => ({
        canExecute: (sessionId: string) => this.bashCircuitBreaker.canExecute(sessionId),
        recordSuccess: (sessionId: string) => this.bashCircuitBreaker.recordSuccess(sessionId),
        recordTimeout: (sessionId: string) => this.bashCircuitBreaker.recordTimeout(sessionId),
        recordSpawnError: (sessionId: string) =>
          this.bashCircuitBreaker.recordSpawnError(sessionId),
        hasOpenCircuit: () => this.bashCircuitBreaker.hasOpenCircuit(),
        getMetrics: () => this.bashCircuitBreaker.getMetrics(),
      }),
      getDefaultCommandTimeoutMs: () => this.defaultCommandTimeoutMs,
    };
  }

  /**
   * Build the metrics response (extracted for handler use).
   */
  private buildMetricsResponse(): RpcResponse {
    const governorMetrics = this.governor.getMetrics();
    const replayStats = this.replayStore.getStats();
    const versionStats = this.versionStore.getStats();
    const executionStats = this.executionEngine.getStats();
    const lockStats = this.lockManager.getStats();
    const extensionUIStats = this.extensionUI.getStats();
    const circuitBreakerMetrics = this.circuitBreakers.getAllMetrics();
    const bashCircuitBreakerMetrics = this.bashCircuitBreaker.getMetrics();
    const sessionStoreStats = {
      metadataResetCount: this.sessionStore.getMetadataResetCount(),
    };
    const journalStats = this.commandJournal.getStats();
    const recoveredOutcomeCount = this.startupRecoverySnapshot?.recoveredOutcomes ?? 0;
    const recoveredInFlightFailures = this.startupRecoverySnapshot?.recoveredInFlightFailures ?? 0;

    return {
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
          sessionStore: sessionStoreStats,
          journal: {
            enabled: journalStats.enabled,
            initialized: journalStats.initialized,
            journalPath: journalStats.journalPath,
            schemaVersion: journalStats.schemaVersion,
            appendFailurePolicy: journalStats.appendFailurePolicy,
            redaction: journalStats.redaction,
            entriesWritten: journalStats.entriesWritten,
            writeErrors: journalStats.writeErrors,
            entriesScanned: journalStats.entriesScanned,
            malformedEntries: journalStats.malformedEntries,
            unsupportedVersionEntries: journalStats.unsupportedVersionEntries,
            recoveredOutcomes: recoveredOutcomeCount,
            recoveredInFlightFailures,
            retention: journalStats.retention,
            compaction: journalStats.compaction,
          },
        },
        circuitBreakers: circuitBreakerMetrics,
        bashCircuitBreaker: bashCircuitBreakerMetrics,
      },
    };
  }

  /**
   * Build the health check response (extracted for handler use).
   */
  private buildHealthResponse(): RpcResponse {
    const health = this.governor.isHealthy();
    const hasOpenCircuit = this.circuitBreakers.hasOpenCircuit();
    const hasOpenBashCircuit = this.bashCircuitBreaker.hasOpenCircuit();

    const issues = [...health.issues];
    if (hasOpenCircuit) {
      issues.push("One or more LLM provider circuits are open");
    }
    if (hasOpenBashCircuit) {
      issues.push("Bash command circuit breaker is open");
    }

    return {
      type: "response",
      command: "health_check",
      success: true,
      data: {
        ...health,
        hasOpenCircuit,
        hasOpenBashCircuit,
        issues,
      },
    };
  }

  /**
   * Build startup durable recovery summary payload.
   * Exposes deterministic boot-time recovery classification to clients.
   */
  private buildStartupRecoveryData(): StartupRecoveryData {
    const stats = this.commandJournal.getStats();
    const snapshot = this.startupRecoverySnapshot;

    return {
      enabled: stats.enabled,
      initialized: stats.initialized,
      initState: this.durableInitState,
      initializationError: this.durableInitError ?? undefined,
      journalPath: snapshot?.journalPath ?? stats.journalPath,
      schemaVersion: snapshot?.schemaVersion ?? stats.schemaVersion,
      entriesScanned: snapshot?.entriesScanned ?? stats.entriesScanned,
      malformedEntries: snapshot?.malformedEntries ?? stats.malformedEntries,
      unsupportedVersionEntries:
        snapshot?.unsupportedVersionEntries ?? stats.unsupportedVersionEntries,
      recoveredOutcomes: snapshot?.recoveredOutcomes ?? 0,
      recoveredOutcomeIds: snapshot?.recoveredOutcomeIds ?? [],
      recoveredOutcomeIdsTruncated: snapshot?.recoveredOutcomeIdsTruncated ?? false,
      recoveredInFlightFailures: snapshot?.recoveredInFlightFailures ?? 0,
      recoveredInFlight: snapshot?.recoveredInFlight ?? [],
      recoveredInFlightTruncated: snapshot?.recoveredInFlightTruncated ?? false,
      maxItemsReturned: STARTUP_RECOVERY_MAX_ITEMS,
    };
  }

  /**
   * Redact sensitive startup recovery details for broadcast convenience events.
   * Full diagnostics remain available via explicit get_startup_recovery command.
   */
  private redactStartupRecoveryData(data: StartupRecoveryData): StartupRecoveryData {
    return {
      ...data,
      journalPath: "[redacted]",
      initializationError: data.initializationError
        ? "Initialization failed (details redacted; call get_startup_recovery for full diagnostics)"
        : undefined,
      recoveredOutcomeIds: [],
      recoveredOutcomeIdsTruncated: data.recoveredOutcomeIdsTruncated || data.recoveredOutcomes > 0,
      recoveredInFlight: [],
      recoveredInFlightTruncated:
        data.recoveredInFlightTruncated || data.recoveredInFlightFailures > 0,
    };
  }

  /**
   * Build startup durable recovery response for get_startup_recovery command.
   */
  private buildStartupRecoveryResponse(id?: string): RpcResponse {
    return {
      id,
      type: "response",
      command: "get_startup_recovery",
      success: true,
      data: this.buildStartupRecoveryData(),
    };
  }

  /**
   * Build optional startup recovery summary broadcast event.
   * Endpoint-first flow remains canonical; this is a convenience signal.
   */
  getStartupRecoverySummaryEvent(options: { includeSensitiveData?: boolean } = {}): {
    type: "startup_recovery_summary";
    data: StartupRecoveryData;
  } {
    const { includeSensitiveData = true } = options;
    const raw = this.buildStartupRecoveryData();

    return {
      type: "startup_recovery_summary",
      data: includeSensitiveData ? raw : this.redactStartupRecoveryData(raw),
    };
  }

  /**
   * Build bounded command history response from durable journal entries.
   */
  private async buildCommandHistoryResponse(query: {
    id?: string;
    sessionIdFilter?: string;
    commandId?: string;
    fromTimestamp?: number;
    toTimestamp?: number;
    limit?: number;
  }): Promise<RpcResponse> {
    const historyQuery: CommandHistoryQuery = {
      sessionId: query.sessionIdFilter,
      commandId: query.commandId,
      fromTimestamp: query.fromTimestamp,
      toTimestamp: query.toTimestamp,
      limit: query.limit,
    };
    const history = await this.commandJournal.queryHistory(historyQuery);

    return {
      id: query.id,
      type: "response",
      command: "get_command_history",
      success: true,
      data: {
        enabled: history.enabled,
        initialized: this.commandJournal.getStats().initialized,
        initState: this.durableInitState,
        initializationError: this.durableInitError ?? undefined,
        journalPath: history.journalPath,
        schemaVersion: history.schemaVersion,
        filters: {
          sessionIdFilter: query.sessionIdFilter,
          commandId: query.commandId,
          fromTimestamp: query.fromTimestamp,
          toTimestamp: query.toTimestamp,
        },
        entries: history.entries,
        returned: history.entries.length,
        truncated: history.truncated,
        maxItemsReturned: history.maxItemsReturned,
        maxItemsAllowed: MAX_COMMAND_HISTORY_LIMIT,
      },
    };
  }

  // ==========================================================================
  // COMMAND EXECUTION
  // ==========================================================================

  async executeCommand(
    command: RpcCommand,
    options: { principal?: string } = {}
  ): Promise<RpcResponse> {
    const id = getCommandId(command);
    const commandType = getCommandType(command);
    const isDurableObservabilityCommand =
      commandType === "get_startup_recovery" || commandType === "get_command_history";

    // Durable observability commands must remain available even when durable init fails,
    // but they should still flow through normal admission/replay/lifecycle handling.
    if (isDurableObservabilityCommand) {
      try {
        await this.ensureDurableJournalInitialized();
      } catch {
        // Intentionally ignored: response should still include failure state/details.
      }
    } else {
      try {
        await this.ensureDurableJournalInitialized();
      } catch (error) {
        return {
          id,
          type: "response",
          command: commandType ?? "unknown",
          success: false,
          error: `Durable journal initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const sessionId = getSessionId(command);
    const commandId = this.replayStore.getOrCreateCommandId(command);
    const dependsOn = getCommandDependsOn(command) ?? [];
    const ifSessionVersion = getCommandIfSessionVersion(command);
    const idempotencyKey = getCommandIdempotencyKey(command);
    const laneKey = this.executionEngine.getLaneKey(command);
    const fingerprint = this.replayStore.getCommandFingerprint(command);
    const isExplicitId = typeof id === "string" && !id.startsWith(SYNTHETIC_ID_PREFIX);

    // Check for shutdown / disposed runtime - reject new commands during teardown
    if (this.runtimeDisposed) {
      return {
        id,
        type: "response",
        command: commandType ?? "unknown",
        success: false,
        error: "Server has completed shutdown",
      };
    }

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

    const finalizeResponse = (response: RpcResponse): RpcResponse => {
      const finishedAppend = this.appendCommandLifecycleToJournal({
        phase: "command_finished",
        commandId,
        commandType,
        laneKey,
        fingerprint,
        explicitId: isExplicitId,
        sessionId,
        dependsOn,
        ifSessionVersion,
        idempotencyKey,
        success: response.success,
        error: response.success ? undefined : response.error,
        sessionVersion: response.sessionVersion,
        replayed: response.replayed,
        timedOut: response.timedOut,
        response,
      });

      let finalizedResponse = response;
      if (!finishedAppend.ok && finishedAppend.failClosed && !isDurableObservabilityCommand) {
        finalizedResponse = {
          id: response.id ?? id,
          type: "response",
          command: response.command,
          success: false,
          error: finishedAppend.error ?? "Durable journal append failed during command_finished",
        };

        const fallbackAppend = this.appendFailClosedTerminalFailureToJournal({
          commandId,
          commandType,
          laneKey,
          fingerprint,
          explicitId: isExplicitId,
          sessionId,
          dependsOn,
          ifSessionVersion,
          idempotencyKey,
          success: finalizedResponse.success,
          error: finalizedResponse.error,
          sessionVersion: finalizedResponse.sessionVersion,
          replayed: finalizedResponse.replayed,
          timedOut: finalizedResponse.timedOut,
          response: finalizedResponse,
        });

        if (!fallbackAppend.ok && fallbackAppend.error) {
          finalizedResponse = {
            ...finalizedResponse,
            error: `${finalizedResponse.error ?? "Durable journal append failed during command_finished"} (fallback persistence also failed: ${fallbackAppend.error})`,
          };
        }
      }

      this.broadcastCommandLifecycle("command_finished", {
        commandId,
        commandType,
        sessionId,
        dependsOn,
        ifSessionVersion,
        idempotencyKey,
        success: finalizedResponse.success,
        error: finalizedResponse.success ? undefined : finalizedResponse.error,
        sessionVersion: finalizedResponse.sessionVersion,
        replayed: finalizedResponse.replayed,
      });

      return finalizedResponse;
    };

    // Check for replay opportunities or conflicts (ADR-0001: Free replay)
    // Replay is O(1) lookup - no execution cost, should not consume rate limit
    const replayCheck = this.replayStore.checkReplay(command, fingerprint);

    if (replayCheck.kind === "conflict") {
      return finalizeResponse(replayCheck.response);
    }

    if (replayCheck.kind === "replay_cached") {
      return finalizeResponse(replayCheck.response);
    }

    if (replayCheck.kind === "replay_inflight") {
      const replayed = await replayCheck.promise;
      return finalizeResponse(replayed);
    }

    // ADR-0001: Rate limiting only for NEW executions (replay is free)
    const rateLimitTarget = getRateLimitTarget(command as RpcCommand & { sessionId?: string });
    const rateLimitResult = this.governor.canExecuteCommand(rateLimitTarget.key);
    if (!rateLimitResult.allowed) {
      return finalizeResponse({
        id,
        type: "response",
        command: commandType,
        success: false,
        error: rateLimitResult.reason,
      });
    }

    let extensionUIRateLimitGeneration: number | undefined;
    const refundAdmissionCharges = () => {
      if (typeof rateLimitResult.generation === "number") {
        this.governor.refundCommand(rateLimitTarget.key, rateLimitResult.generation);
      }
      if (sessionId && typeof extensionUIRateLimitGeneration === "number") {
        this.governor.refundExtensionUIResponse(sessionId, extensionUIRateLimitGeneration);
      }
    };

    // Additional rate limiting for extension_ui_response (prevents spam)
    if (commandType === "extension_ui_response" && sessionId) {
      const extRateLimitResult = this.governor.canExecuteExtensionUIResponse(sessionId);
      if (!extRateLimitResult.allowed) {
        refundAdmissionCharges();
        return finalizeResponse({
          id,
          type: "response",
          command: commandType,
          success: false,
          error: extRateLimitResult.reason,
        });
      }
      extensionUIRateLimitGeneration = extRateLimitResult.generation;
    }

    const trackedExecution = createDeferred<RpcResponse>();
    const inFlightRecord: InFlightCommandRecord = {
      commandType,
      laneKey,
      fingerprint,
      promise: trackedExecution.promise,
    };
    let explicitInFlightRegistered = false;
    let idempotencyInFlightRegistered = false;
    let trackedExecutionSettled = false;

    const settleTrackedExecution = (terminalResponse: RpcResponse): void => {
      if (trackedExecutionSettled) {
        return;
      }
      trackedExecutionSettled = true;
      trackedExecution.resolve(terminalResponse);
    };

    if (id) {
      // ADR-0001: Reject if in-flight limit reached (don't evict - breaks dependencies)
      const registered = this.replayStore.registerInFlight(id, inFlightRecord);
      if (!registered) {
        refundAdmissionCharges();
        return finalizeResponse({
          id,
          type: "response",
          command: commandType,
          success: false,
          error: "Server busy - too many concurrent commands. Please retry.",
        });
      }
      explicitInFlightRegistered = true;
    }

    if (idempotencyKey) {
      this.replayStore.registerIdempotencyInFlight(command, idempotencyKey, inFlightRecord);
      idempotencyInFlightRegistered = true;
    }

    let response: RpcResponse;

    try {
      const acceptedAppend = this.appendCommandLifecycleToJournal({
        phase: "command_accepted",
        commandId,
        commandType,
        laneKey,
        fingerprint,
        explicitId: isExplicitId,
        sessionId,
        dependsOn,
        ifSessionVersion,
        idempotencyKey,
      });

      if (!acceptedAppend.ok && acceptedAppend.failClosed && !isDurableObservabilityCommand) {
        response = {
          id,
          type: "response",
          command: commandType,
          success: false,
          error: acceptedAppend.error ?? "Durable journal append failed during command_accepted",
        };
      } else {
        this.broadcastCommandLifecycle("command_accepted", {
          commandId,
          commandType,
          sessionId,
          dependsOn,
          ifSessionVersion,
          idempotencyKey,
        });
        const commandExecution = this.executionEngine.runOnLane<RpcResponse>(
          laneKey,
          async (): Promise<RpcResponse> => {
            if (this.runtimeDisposed) {
              return {
                id,
                type: "response",
                command: commandType,
                success: false,
                error: "Command cancelled because server shutdown completed",
              };
            }

            const startedAppend = this.appendCommandLifecycleToJournal({
              phase: "command_started",
              commandId,
              commandType,
              laneKey,
              fingerprint,
              explicitId: isExplicitId,
              sessionId,
              dependsOn,
              ifSessionVersion,
              idempotencyKey,
            });

            if (!startedAppend.ok && startedAppend.failClosed && !isDurableObservabilityCommand) {
              return {
                id,
                type: "response",
                command: commandType,
                success: false,
                error:
                  startedAppend.error ?? "Durable journal append failed during command_started",
              };
            }

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
              const dependencyResult = await this.executionEngine.awaitDependencies(
                dependsOn,
                laneKey
              );
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

            const rawResponse = await this.executeCommandInternal(
              command,
              id,
              commandType,
              options.principal
            );
            if (this.runtimeDisposed) {
              return {
                id,
                type: "response",
                command: commandType,
                success: false,
                error: "Command cancelled because server shutdown completed",
              };
            }
            return this.versionStore.applyVersion(command, rawResponse);
          }
        );

        this.registerInFlightCommand(commandExecution);

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
      }
    } catch (unexpectedError) {
      response = {
        id,
        type: "response",
        command: commandType,
        success: false,
        error: unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError),
      };
    }

    const finalizedResponse = finalizeResponse(response);
    settleTrackedExecution(finalizedResponse);

    // ADR-0001: ATOMIC OUTCOME STORAGE
    // Store outcome BEFORE returning (not in async callback)
    // This ensures same command ID always returns same response
    //
    // Only store outcomes for EXPLICIT client IDs (not synthetic IDs).
    // Synthetic IDs (anon:timestamp:seq) are server-generated for anonymous
    // commands and should not be stored to prevent unbounded memory growth.
    // Clients must provide explicit IDs if they want replay semantics.
    if (isExplicitId) {
      try {
        this.replayStore.storeCommandOutcome({
          commandId: id,
          commandType,
          laneKey,
          fingerprint,
          success: finalizedResponse.success,
          error: finalizedResponse.success ? undefined : finalizedResponse.error,
          response: finalizedResponse,
          sessionVersion: finalizedResponse.sessionVersion,
          finishedAt: Date.now(),
        });
      } catch (outcomeError) {
        console.error(`[executeCommand] Failed to store command outcome for ${id}:`, outcomeError);
      }
    }

    if (explicitInFlightRegistered && id && this.replayStore.getInFlight(id) === inFlightRecord) {
      this.replayStore.unregisterInFlight(id, inFlightRecord);
    }

    if (idempotencyInFlightRegistered && idempotencyKey) {
      this.replayStore.unregisterIdempotencyInFlight(command, idempotencyKey, inFlightRecord);
    }

    // Cache terminal idempotency outcome (including timeout responses)
    if (idempotencyKey) {
      this.replayStore.cacheIdempotencyResult({
        command,
        idempotencyKey,
        commandType,
        fingerprint,
        response: finalizedResponse,
      });
    }

    return finalizedResponse;
  }

  /**
   * Internal command execution (called after tracking and rate limiting).
   * Routes to server command handlers or session command handlers.
   */
  private async executeCommandInternal(
    command: RpcCommand,
    id: string | undefined,
    commandType: string,
    principal?: string
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
      const context = this.createCommandContext(principal);

      // Try server command handlers first
      const serverResponse = routeServerCommand(command, context);
      if (serverResponse !== undefined) {
        const resolved = await Promise.resolve(serverResponse);
        return { ...resolved, id };
      }

      // Session commands - get the session first
      const cmdSessionId = getSessionId(command);
      const session = this.sessions.get(cmdSessionId!);
      if (!session) {
        return failResponse(`Session ${cmdSessionId} not found`);
      }

      // Record heartbeat for valid session activity
      this.governor.recordHeartbeat(cmdSessionId!);

      // ADR-0010: Circuit breaker for LLM commands
      const llmResponse = await executeLLMCommand(command, session, context);
      if (llmResponse !== undefined) {
        if (!llmResponse.success) {
          return { ...llmResponse, id };
        }
        return llmResponse;
      }

      // Bash circuit breaker protection
      const bashResponse = await executeBashCommand(command, session, context);
      if (bashResponse !== undefined) {
        if (!bashResponse.success) {
          return { ...bashResponse, id };
        }
        return bashResponse;
      }

      // Other session commands: route without circuit breaker
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

  /**
   * Create an AgentSession while sanitizing npm prefix env leakage from npm scripts.
   *
   * npm sets npm_config_prefix for child processes. If inherited here,
   * pi-coding-agent's global package installation can be redirected into the
   * current project (e.g. ./lib/node_modules), causing flaky session creation.
   */
  private async createAgentSessionWithSanitizedNpmEnv(
    options: Parameters<typeof createAgentSession>[0]
  ): Promise<Awaited<ReturnType<typeof createAgentSession>>> {
    const previousCreation = sanitizedAgentSessionCreationTail;
    let releaseCreation: (() => void) | undefined;
    sanitizedAgentSessionCreationTail = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });

    await previousCreation.catch(() => {
      // Preserve queue progress even if an earlier creation failed.
    });

    const snapshots = SANITIZED_NPM_ENV_KEYS.map((key) => ({
      key,
      had: Object.hasOwn(process.env, key),
      value: process.env[key],
    }));
    const sanitizedKeys = snapshots
      .filter((snapshot) => snapshot.had)
      .map((snapshot) => snapshot.key);

    if (sanitizedKeys.length > 0 && !this.npmSanitizationDiagnosticLogged) {
      this.npmSanitizationDiagnosticLogged = true;
      this.debugLogger?.("Sanitized npm prefix env for AgentSession creation", {
        keys: sanitizedKeys,
        reason: "Prevent npm script env leakage from redirecting global installs",
      });
    }

    for (const snapshot of snapshots) {
      if (snapshot.had) {
        delete process.env[snapshot.key];
      }
    }

    try {
      return await createAgentSession(options);
    } finally {
      for (const snapshot of snapshots) {
        if (!snapshot.had) continue;
        if (snapshot.value === undefined) {
          delete process.env[snapshot.key];
        } else {
          process.env[snapshot.key] = snapshot.value;
        }
      }
      releaseCreation?.();
    }
  }

  private generateSessionId(): string {
    // Use crypto for collision-safe ID generation
    const timestamp = Date.now().toString(36);
    const random = crypto.randomUUID().split("-")[0];
    return `session-${timestamp}-${random}`;
  }
}
