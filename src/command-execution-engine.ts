/**
 * Command Execution Engine - manages lane serialization, dependency waits, and timeouts.
 *
 * Responsibilities:
 * - Deterministic per-lane command serialization
 * - Dependency resolution with timeout
 * - Command timeout orchestration with abort hooks
 * - Lifecycle event emission
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { RpcCommand, RpcResponse, SessionResolver } from "./types.js";
import { getSessionId } from "./types.js";
import type { CommandReplayStore } from "./command-replay-store.js";
import type { SessionVersionStore } from "./session-version-store.js";
import { getCommandTimeoutPolicy } from "./command-classification.js";

/** Default timeout for session commands (5 minutes for LLM operations) */
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Short command timeout (30 seconds) */
const SHORT_COMMAND_TIMEOUT_MS = 30 * 1000;

/** Max time to wait for a dependency command to complete. */
const DEFAULT_DEPENDENCY_WAIT_TIMEOUT_MS = 30 * 1000;

/**
 * Abort handler for a specific command type.
 * Called when a command times out to attempt cancellation.
 */
export type AbortHandler = (session: AgentSession) => void | Promise<void>;

/**
 * Default abort handlers for built-in command types.
 * Maps command types to their abort methods on AgentSession.
 */
const DEFAULT_ABORT_HANDLERS: Partial<Record<string, AbortHandler>> = {
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
export function withTimeout<T>(
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

      // Wrap onTimeout in try-catch to handle both sync and async errors
      let onTimeoutPromise: Promise<void>;
      try {
        onTimeoutPromise = Promise.resolve(onTimeout?.());
      } catch {
        onTimeoutPromise = Promise.resolve();
      }

      onTimeoutPromise
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

/**
 * Configuration options for the execution engine.
 */
export interface ExecutionEngineOptions {
  defaultCommandTimeoutMs?: number;
  shortCommandTimeoutMs?: number;
  dependencyWaitTimeoutMs?: number;
  /** Custom abort handlers for command types (extends defaults) */
  abortHandlers?: Partial<Record<string, AbortHandler>>;
}

/**
 * Command Execution Engine - manages lane serialization and dependency waits.
 *
 * Extracted from PiSessionManager to isolate:
 * - Per-lane command serialization
 * - Dependency resolution with timeout
 * - Command timeout with abort hooks
 */
export class CommandExecutionEngine {
  /** Deterministic per-lane command serialization tails. */
  private laneTails = new Map<string, Promise<void>>();

  private readonly replayStore: CommandReplayStore;
  private readonly versionStore: SessionVersionStore;
  private readonly sessionResolver: SessionResolver;
  private readonly abortHandlers: Partial<Record<string, AbortHandler>>;

  private readonly defaultCommandTimeoutMs: number;
  private readonly shortCommandTimeoutMs: number;
  private readonly dependencyWaitTimeoutMs: number;

  constructor(
    replayStore: CommandReplayStore,
    versionStore: SessionVersionStore,
    sessionResolver: SessionResolver,
    options: ExecutionEngineOptions = {}
  ) {
    this.replayStore = replayStore;
    this.versionStore = versionStore;
    this.sessionResolver = sessionResolver;

    // Merge custom abort handlers with defaults (custom takes precedence)
    this.abortHandlers = { ...DEFAULT_ABORT_HANDLERS, ...options.abortHandlers };

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
        : DEFAULT_DEPENDENCY_WAIT_TIMEOUT_MS;
  }

  /**
   * Get statistics about the execution engine state.
   */
  getStats(): { laneCount: number } {
    return { laneCount: this.laneTails.size };
  }

  // ==========================================================================
  // LANE SERIALIZATION
  // ==========================================================================

  /**
   * Get the lane key for a command.
   * Session commands serialize per-session; server commands serialize together.
   */
  getLaneKey(command: RpcCommand): string {
    const sessionId = getSessionId(command);
    if (sessionId) return `session:${sessionId}`;
    return "server";
  }

  /**
   * Run a task in a deterministic serialized lane.
   * Commands in the same lane execute sequentially.
   */
  async runOnLane<T>(laneKey: string, task: () => Promise<T>): Promise<T> {
    const previousTail = this.laneTails.get(laneKey) ?? Promise.resolve();

    let releaseCurrent: (() => void) | undefined;
    const currentTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    // Store the lane tail promise for later comparison
    const laneTail = previousTail.then(
      () => currentTail,
      () => currentTail
    );
    this.laneTails.set(laneKey, laneTail);

    await previousTail.catch((error) => {
      // Previous command failure should not break lane sequencing.
      // Log for observability but continue.
      if (error !== undefined) {
        console.error(`[CommandExecutionEngine] Previous lane task failed for ${laneKey}:`, error);
      }
    });

    try {
      return await task();
    } finally {
      releaseCurrent?.();
      // Only delete if our lane tail is still the current one (not replaced by another task)
      if (this.laneTails.get(laneKey) === laneTail) {
        this.laneTails.delete(laneKey);
      }
    }
  }

  // ==========================================================================
  // DEPENDENCY RESOLUTION
  // ==========================================================================

  /**
   * Wait for dependency commands to complete.
   * Returns error if any dependency fails or times out.
   *
   * Note: Cross-lane dependency cycles (A→B, B→A) are detected by timeout
   * rather than explicit cycle detection. This is acceptable because:
   * 1. Cross-lane dependencies are rare
   * 2. The dependencyWaitTimeoutMs (default 30s) prevents indefinite deadlock
   * 3. Same-lane cycles are explicitly detected below
   */
  async awaitDependencies(
    dependsOn: string[],
    laneKey: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    for (const dependencyId of dependsOn) {
      if (!dependencyId) {
        return { ok: false, error: "Dependency ID must be non-empty" };
      }

      const inFlight = this.replayStore.getInFlight(dependencyId);
      if (inFlight) {
        // Same-lane check: commands in the same lane execute sequentially,
        // so waiting for a same-lane dependency would deadlock
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

      const completed = this.replayStore.getCommandOutcome(dependencyId);
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

  // ==========================================================================
  // TIMEOUT MANAGEMENT
  // ==========================================================================

  /**
   * Resolve timeout policy for a command.
   * Returns null for commands that cannot be safely cancelled.
   */
  getCommandTimeoutMs(commandType: string): number | null {
    return getCommandTimeoutPolicy(commandType, {
      defaultTimeoutMs: this.defaultCommandTimeoutMs,
      shortTimeoutMs: this.shortCommandTimeoutMs,
    });
  }

  /**
   * Best-effort cancellation for timed-out commands.
   * Uses configured abort handlers (defaults + custom overrides).
   */
  async abortTimedOutCommand(command: RpcCommand): Promise<void> {
    const sessionId = getSessionId(command);
    if (!sessionId) return;

    const session = this.sessionResolver.getSession(sessionId);
    if (!session) return;

    const abortHandler = this.abortHandlers[command.type];
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
   * Execute a command with timeout.
   */
  async executeWithTimeout(
    commandType: string,
    promise: Promise<RpcResponse>,
    command: RpcCommand
  ): Promise<RpcResponse> {
    const timeoutMs = this.getCommandTimeoutMs(commandType);

    if (timeoutMs === null) {
      return promise;
    }

    return withTimeout(promise, timeoutMs, commandType, () => this.abortTimedOutCommand(command));
  }

  // ==========================================================================
  // VERSION CHECKS
  // ==========================================================================

  /**
   * Check if a session version matches the expected version.
   * Returns error object if mismatch, undefined if OK.
   *
   * @param sessionId - The session to check
   * @param ifSessionVersion - The expected version
   * @param commandType - The command type for error context (preserves caller's context)
   */
  checkSessionVersion(
    sessionId: string,
    ifSessionVersion: number,
    commandType: string
  ): { type: "response"; command: string; success: false; error: string } | undefined {
    const current = this.versionStore.getVersion(sessionId);
    if (current === undefined) {
      return {
        type: "response",
        command: commandType,
        success: false,
        error: `Session ${sessionId} not found for ifSessionVersion=${ifSessionVersion}`,
      };
    }
    if (current !== ifSessionVersion) {
      return {
        type: "response",
        command: commandType,
        success: false,
        error: `Session version mismatch: expected ${ifSessionVersion}, got ${current}`,
      };
    }
    return undefined;
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Clear all lane state (used during disposal).
   */
  clear(): void {
    this.laneTails.clear();
  }
}
