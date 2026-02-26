/**
 * Command Replay Store - manages idempotency, duplicate detection, and outcome history.
 *
 * Responsibilities:
 * - Idempotency key replay (cached responses for retry safety)
 * - Command ID deduplication (completed outcomes + in-flight tracking)
 * - Fingerprint conflict detection (prevent same ID with different payload)
 * - Bounded outcome retention (LRU-style trimming)
 */

import type { RpcCommand, RpcResponse } from "./types.js";
import { getCommandId, getCommandIdempotencyKey, getSessionId } from "./types.js";

/** How long idempotency results are replayable (10 minutes). */
const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/** Maximum number of retained command outcomes for dependency checks. */
const DEFAULT_MAX_COMMAND_OUTCOMES = 2000;

/** Maximum number of in-flight commands to track (prevents unbounded memory). */
const DEFAULT_MAX_IN_FLIGHT_COMMANDS = 10000;

/** Reserved prefix for server-generated command IDs. Client IDs matching this are rejected. */
export const SYNTHETIC_ID_PREFIX = "anon:";

/**
 * Record of a completed command execution.
 * Used for dependency resolution and duplicate-id replay.
 */
export interface CommandOutcomeRecord {
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

/**
 * Record of an in-flight command execution.
 * Used for dependency waits and duplicate-id replay.
 */
export interface InFlightCommandRecord {
  commandType: string;
  laneKey: string;
  fingerprint: string;
  promise: Promise<RpcResponse>;
}

/**
 * Input for caching an idempotency result.
 */
export interface IdempotencyCacheInput {
  command: RpcCommand;
  idempotencyKey: string;
  commandType: string;
  fingerprint: string;
  response: RpcResponse;
}
export interface IdempotencyCacheEntry {
  expiresAt: number;
  commandType: string;
  fingerprint: string;
  response: RpcResponse;
}

/**
 * Result of checking for replay conflicts.
 *
 * This discriminated union enables type-safe handling of all replay scenarios:
 *
 * - `proceed`: No replay possible, execute the command normally
 * - `conflict`: Fingerprint mismatch - same ID/key but different payload
 * - `replay_cached`: Found cached response, return it immediately
 * - `replay_inflight`: Command with same ID is executing, await its promise
 *
 * @example
 * ```typescript
 * const result = store.checkReplay(command, fingerprint);
 * switch (result.kind) {
 *   case "proceed": // execute normally
 *   case "conflict": return result.response; // error response
 *   case "replay_cached": return result.response; // cached response
 *   case "replay_inflight": return await result.promise; // wait for in-flight
 * }
 * ```
 */
export type ReplayCheckResult =
  | { kind: "proceed" }
  | { kind: "conflict"; response: RpcResponse }
  | { kind: "replay_cached"; response: RpcResponse }
  | { kind: "replay_inflight"; promise: Promise<RpcResponse> };

/**
 * Configuration options for the replay store.
 */
export interface ReplayStoreOptions {
  idempotencyTtlMs?: number;
  maxCommandOutcomes?: number;
  /** Maximum in-flight commands to track. Excess is rejected (ADR-0001: reject, don't evict). */
  maxInFlightCommands?: number;
}

/**
 * Statistics about store state for monitoring.
 */
export interface ReplayStoreStats {
  /** Number of in-flight commands being tracked */
  inFlightCount: number;
  /** Number of completed command outcomes stored */
  outcomeCount: number;
  /** Number of idempotency cache entries */
  idempotencyCacheSize: number;
  /** Maximum configured in-flight commands */
  maxInFlightCommands: number;
  /** Maximum configured command outcomes */
  maxCommandOutcomes: number;
  /** Count of in-flight rejections due to exceeding max (ADR-0001: reject, don't evict) */
  inFlightRejections: number;
}

/**
 * Command Replay Store - manages idempotency and duplicate detection.
 *
 * Extracted from PiSessionManager to isolate:
 * - Replay semantics (idempotency keys, command IDs)
 * - Fingerprint conflict detection
 * - Bounded outcome history
 */
export class CommandReplayStore {
  /** In-flight commands by command id (for dependency waits and duplicate-id replay). */
  private commandInFlightById = new Map<string, InFlightCommandRecord>();
  /** Insertion order for in-flight commands (for bounded eviction). */
  private inFlightOrder: string[] = [];

  /** Completed command outcomes (for dependency checks and duplicate-id replay). */
  private commandOutcomes = new Map<string, CommandOutcomeRecord>();

  /** Bounded insertion order to trim commandOutcomes memory. */
  private commandOutcomeOrder: string[] = [];

  /** Idempotency replay cache. */
  private idempotencyCache = new Map<string, IdempotencyCacheEntry>();

  /** Sequence for synthetic command IDs when client omits id. */
  private syntheticCommandSequence = 0;
  /** Process start time for unique synthetic IDs that don't collide after clear(). */
  private readonly processStartTime = Date.now();

  private readonly idempotencyTtlMs: number;
  private readonly maxCommandOutcomes: number;
  private readonly maxInFlightCommands: number;
  private inFlightRejections = 0;

  constructor(options: ReplayStoreOptions = {}) {
    this.idempotencyTtlMs =
      typeof options.idempotencyTtlMs === "number" && options.idempotencyTtlMs > 0
        ? options.idempotencyTtlMs
        : DEFAULT_IDEMPOTENCY_TTL_MS;
    this.maxCommandOutcomes =
      typeof options.maxCommandOutcomes === "number" && options.maxCommandOutcomes > 0
        ? options.maxCommandOutcomes
        : DEFAULT_MAX_COMMAND_OUTCOMES;
    this.maxInFlightCommands =
      typeof options.maxInFlightCommands === "number" && options.maxInFlightCommands > 0
        ? options.maxInFlightCommands
        : DEFAULT_MAX_IN_FLIGHT_COMMANDS;
  }

  /**
   * Get statistics about store state for monitoring.
   */
  getStats(): ReplayStoreStats {
    return {
      inFlightCount: this.commandInFlightById.size,
      outcomeCount: this.commandOutcomes.size,
      idempotencyCacheSize: this.idempotencyCache.size,
      maxInFlightCommands: this.maxInFlightCommands,
      maxCommandOutcomes: this.maxCommandOutcomes,
      inFlightRejections: this.inFlightRejections,
    };
  }

  // ==========================================================================
  // COMMAND ID GENERATION
  // ==========================================================================

  /**
   * Get or create a deterministic command ID.
   * Returns explicit ID if provided, otherwise generates a synthetic one.
   *
   * Synthetic IDs use process-start-time + sequence to guarantee uniqueness:
   * 1. Process start time distinguishes IDs across server restarts
   * 2. Sequence guarantees uniqueness within a process lifetime
   * 3. Clear() resets sequence but start time stays same (collision-safe within run)
   *
   * NOTE: This method has a side effect (increments sequence) when generating.
   */
  getOrCreateCommandId(command: RpcCommand): string {
    const explicitId = getCommandId(command);
    if (explicitId) return explicitId;

    this.syntheticCommandSequence += 1;
    return `${SYNTHETIC_ID_PREFIX}${this.processStartTime}:${this.syntheticCommandSequence}`;
  }

  // ==========================================================================
  // FINGERPRINTING
  // ==========================================================================

  /**
   * Compute a fingerprint for conflict detection.
   * Excludes retry identity fields (id, idempotencyKey) since those
   * don't affect semantic equivalence - only determine replay mechanics.
   */
  getCommandFingerprint(command: RpcCommand): string {
    const { id: _id, idempotencyKey: _key, ...rest } = command;
    return JSON.stringify(rest);
  }

  // ==========================================================================
  // IDEMPOTENCY KEY CACHE
  // ==========================================================================

  /**
   * Build a cache key for idempotency lookup.
   */
  private buildIdempotencyCacheKey(command: RpcCommand, key: string): string {
    const sessionId = getSessionId(command) ?? "_server_";
    return `${sessionId}:${key}`;
  }

  /**
   * Remove expired entries from the idempotency cache.
   */
  cleanupIdempotencyCache(now = Date.now()): void {
    for (const [key, entry] of this.idempotencyCache) {
      if (entry.expiresAt <= now) {
        this.idempotencyCache.delete(key);
      }
    }
  }

  /**
   * Store a response in the idempotency cache.
   */
  cacheIdempotencyResult(input: IdempotencyCacheInput): void {
    const cacheKey = this.buildIdempotencyCacheKey(input.command, input.idempotencyKey);
    this.idempotencyCache.set(cacheKey, {
      expiresAt: Date.now() + this.idempotencyTtlMs,
      commandType: input.commandType,
      fingerprint: input.fingerprint,
      response: input.response,
    });
  }

  // ==========================================================================
  // COMMAND OUTCOMES
  // ==========================================================================

  /**
   * Trim old command outcomes to bound memory.
   */
  private trimCommandOutcomes(): void {
    while (this.commandOutcomeOrder.length > this.maxCommandOutcomes) {
      const oldest = this.commandOutcomeOrder.shift();
      if (!oldest) break;
      this.commandOutcomes.delete(oldest);
    }
  }

  /**
   * Store a completed command outcome.
   */
  storeCommandOutcome(outcome: CommandOutcomeRecord): void {
    const existed = this.commandOutcomes.has(outcome.commandId);
    this.commandOutcomes.set(outcome.commandId, outcome);

    if (!existed) {
      this.commandOutcomeOrder.push(outcome.commandId);
      this.trimCommandOutcomes();
    }
  }

  /**
   * Get a completed command outcome by ID.
   */
  getCommandOutcome(commandId: string): CommandOutcomeRecord | undefined {
    return this.commandOutcomes.get(commandId);
  }

  // ==========================================================================
  // IN-FLIGHT TRACKING
  // ==========================================================================

  /**
   * Register an in-flight command.
   *
   * ADR-0001: Rejects when limit exceeded instead of evicting.
   * Eviction breaks dependency chains - if command A depends on command B,
   * and B is evicted, A fails with "unknown dependency". Rejection preserves
   * correctness at the cost of temporary unavailability under load.
   *
   * @returns true if registered, false if limit exceeded
   */
  registerInFlight(
    commandId: string,
    record: InFlightCommandRecord
  ): boolean {
    const existed = this.commandInFlightById.has(commandId);

    // Reject if at capacity and this is a new entry
    if (!existed && this.inFlightOrder.length >= this.maxInFlightCommands) {
      this.inFlightRejections++;
      return false;
    }

    this.commandInFlightById.set(commandId, record);

    if (!existed) {
      this.inFlightOrder.push(commandId);
    }
    return true;
  }

  /**
   * Unregister an in-flight command.
   * Only removes if the record matches (prevents race conditions).
   */
  unregisterInFlight(commandId: string, record: InFlightCommandRecord): void {
    if (this.commandInFlightById.get(commandId) === record) {
      this.commandInFlightById.delete(commandId);
      // Remove from order array
      const idx = this.inFlightOrder.indexOf(commandId);
      if (idx !== -1) {
        this.inFlightOrder.splice(idx, 1);
      }
    }
  }

  /**
   * Get an in-flight command by ID.
   */
  getInFlight(commandId: string): InFlightCommandRecord | undefined {
    return this.commandInFlightById.get(commandId);
  }

  // ==========================================================================
  // REPLAY CHECK (MAIN API)
  // ==========================================================================

  /**
   * Create a conflict response for fingerprint mismatch.
   */
  private createConflictResponse(
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

  /**
   * Clone a cached response for a new request.
   * Preserves or strips ID based on whether the new request has one.
   */
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

  /**
   * Check for replay opportunities or conflicts.
   *
   * Call this BEFORE executing a command. Returns:
   * - "proceed": No replay possible, execute normally
   * - "conflict": Fingerprint mismatch, return error response
   * - "replay_cached": Found cached response, return it (with replayed: true)
   * - "replay_inflight": Found in-flight command, await its promise
   */
  checkReplay(
    command: RpcCommand,
    fingerprint: string
  ): ReplayCheckResult {
    const id = getCommandId(command);
    const commandType = command.type;
    const idempotencyKey = getCommandIdempotencyKey(command);

    // 1. Check idempotency key cache
    if (idempotencyKey) {
      const cacheKey = this.buildIdempotencyCacheKey(command, idempotencyKey);
      const cached = this.idempotencyCache.get(cacheKey);
      if (cached) {
        // Fingerprint conflict?
        if (cached.fingerprint !== fingerprint) {
          return {
            kind: "conflict",
            response: this.createConflictResponse(
              id,
              commandType,
              "idempotencyKey",
              idempotencyKey,
              cached.commandType
            ),
          };
        }

        // Replay cached response
        return {
          kind: "replay_cached",
          response: this.cloneResponseForRequest(
            { ...cached.response, replayed: true },
            id
          ),
        };
      }
    }

    // 2. Check for explicit command ID
    if (id) {
      // 2a. Check completed outcomes
      const completed = this.commandOutcomes.get(id);
      if (completed) {
        // Fingerprint conflict?
        if (completed.fingerprint !== fingerprint) {
          return {
            kind: "conflict",
            response: this.createConflictResponse(
              id,
              commandType,
              "id",
              id,
              completed.commandType
            ),
          };
        }

        // Replay completed response
        return {
          kind: "replay_cached",
          response: this.cloneResponseForRequest(
            { ...completed.response, replayed: true },
            id
          ),
        };
      }

      // 2b. Check in-flight commands
      const inFlight = this.commandInFlightById.get(id);
      if (inFlight) {
        // Fingerprint conflict?
        if (inFlight.fingerprint !== fingerprint) {
          return {
            kind: "conflict",
            response: this.createConflictResponse(
              id,
              commandType,
              "id",
              id,
              inFlight.commandType
            ),
          };
        }

        // Wait for in-flight to complete and replay
        return {
          kind: "replay_inflight",
          promise: inFlight.promise.then((response) =>
            this.cloneResponseForRequest({ ...response, replayed: true }, id)
          ),
        };
      }
    }

    // No replay possible, proceed with execution
    return { kind: "proceed" };
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Clear all state (used during disposal).
   * Note: Does NOT reset syntheticCommandSequence to prevent ID collisions.
   * Process start time ensures uniqueness even after clear.
   */
  clear(): void {
    this.commandInFlightById.clear();
    this.inFlightOrder = [];
    this.commandOutcomes.clear();
    this.commandOutcomeOrder = [];
    this.idempotencyCache.clear();
    // Don't reset syntheticCommandSequence - processStartTime ensures uniqueness
    this.inFlightRejections = 0;
  }
}
