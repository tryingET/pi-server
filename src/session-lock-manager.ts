/**
 * Session Lock Manager - provides mutual exclusion for session ID operations.
 *
 * Prevents race conditions in session creation/deletion:
 * - Two concurrent createSession("same-id") calls both reserve slots
 * - Only one succeeds, but both slots are consumed
 *
 * This manager provides per-session-ID locks with timeout to prevent deadlocks.
 */

/** Default timeout for lock acquisition (5 seconds). */
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

/** Maximum time to hold a lock before warning (30 seconds). */
const LOCK_HOLD_WARNING_MS = 30000;

/** Maximum number of waiters per session lock (prevents memory exhaustion). */
const DEFAULT_MAX_QUEUE_SIZE = 100;

/**
 * A lock handle that must be released after use.
 * Implements RAII pattern via explicit release().
 */
export interface SessionLockHandle {
  sessionId: string;
  acquiredAt: number;
  release: () => void;
}

/**
 * Internal lock state.
 */
interface LockState {
  promise: Promise<void>;
  resolve: () => void;
  acquiredAt: number;
  holder?: string; // Debug info about who holds the lock
}

/**
 * Configuration for the lock manager.
 */
export interface SessionLockManagerOptions {
  /** Timeout for lock acquisition (default: 5000ms). */
  lockTimeoutMs?: number;
  /** Maximum waiters per session lock (default: 100). Prevents memory exhaustion. */
  maxQueueSize?: number;
  /** Enable debug logging for lock operations. */
  debug?: boolean;
}

/**
 * Statistics about the lock manager state.
 */
export interface SessionLockManagerStats {
  /** Number of currently held locks. */
  activeLocks: number;
  /** Number of lock acquisitions that timed out. */
  timeoutCount: number;
  /** Number of currently waiting lock acquisitions. */
  waitingCount: number;
  /** Number of lock acquisitions rejected due to queue full. */
  queueFullRejections: number;
}

/**
 * Session Lock Manager - provides per-session-ID mutual exclusion.
 *
 * Usage:
 * ```typescript
 * const lockManager = new SessionLockManager();
 *
 * async function createSession(sessionId: string) {
 *   const lock = await lockManager.acquire(sessionId);
 *   try {
 *     // Critical section - only one caller per sessionId
 *     await doCreateSession(sessionId);
 *   } finally {
 *     lock.release();
 *   }
 * }
 * ```
 */
export class SessionLockManager {
  private locks = new Map<string, LockState>();
  private waitingQueues = new Map<
    string,
    Array<{ resolve: (handle: SessionLockHandle) => void; reject: (error: Error) => void }>
  >();
  private timeoutCount = 0;
  private queueFullRejections = 0;

  private readonly lockTimeoutMs: number;
  private readonly maxQueueSize: number;
  private readonly debug: boolean;

  constructor(options: SessionLockManagerOptions = {}) {
    this.lockTimeoutMs =
      typeof options.lockTimeoutMs === "number" && options.lockTimeoutMs > 0
        ? options.lockTimeoutMs
        : DEFAULT_LOCK_TIMEOUT_MS;
    this.maxQueueSize =
      typeof options.maxQueueSize === "number" && options.maxQueueSize > 0
        ? options.maxQueueSize
        : DEFAULT_MAX_QUEUE_SIZE;
    this.debug = options.debug ?? false;
  }

  /**
   * Acquire a lock for a session ID.
   * Returns a handle that must be released after use.
   * Throws on timeout to prevent indefinite waiting.
   */
  async acquire(sessionId: string, holder?: string): Promise<SessionLockHandle> {
    const existing = this.locks.get(sessionId);

    if (!existing) {
      // Lock is free, acquire immediately
      return this.acquireImmediate(sessionId, holder);
    }

    // Lock is held, wait in queue
    return this.acquireQueued(sessionId, holder);
  }

  /**
   * Try to acquire a lock without waiting.
   * Returns null if lock is held by another caller.
   */
  tryAcquire(sessionId: string, holder?: string): SessionLockHandle | null {
    if (this.locks.has(sessionId)) {
      return null;
    }
    return this.acquireImmediateSync(sessionId, holder);
  }

  /**
   * Check if a lock is currently held for a session ID.
   */
  isLocked(sessionId: string): boolean {
    return this.locks.has(sessionId);
  }

  /**
   * Get statistics about the lock manager.
   */
  getStats(): SessionLockManagerStats {
    let waitingCount = 0;
    for (const queue of this.waitingQueues.values()) {
      waitingCount += queue.length;
    }

    return {
      activeLocks: this.locks.size,
      timeoutCount: this.timeoutCount,
      waitingCount,
      queueFullRejections: this.queueFullRejections,
    };
  }

  /**
   * Clear all locks (used during disposal or testing).
   * Warning: This can break invariants if locks are still held.
   */
  clear(): void {
    // Reject all waiting acquires
    for (const [sessionId, queue] of this.waitingQueues) {
      for (const { reject } of queue) {
        reject(new Error(`Lock manager cleared while waiting for ${sessionId}`));
      }
    }

    this.waitingQueues.clear();
    this.locks.clear();
    this.timeoutCount = 0;
    this.queueFullRejections = 0;
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private acquireImmediate(sessionId: string, holder?: string): SessionLockHandle {
    let resolveLock: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    const state: LockState = {
      promise,
      resolve: resolveLock!,
      acquiredAt: Date.now(),
      holder,
    };

    this.locks.set(sessionId, state);
    this.log(`Acquired lock for ${sessionId}`, holder);

    // Set up long-hold warning
    const warningTimer = setTimeout(() => {
      console.warn(
        `[SessionLockManager] Lock held for ${sessionId} > ${LOCK_HOLD_WARNING_MS}ms by ${holder ?? "unknown"}`
      );
    }, LOCK_HOLD_WARNING_MS);

    return {
      sessionId,
      acquiredAt: state.acquiredAt,
      release: () => {
        clearTimeout(warningTimer);
        this.release(sessionId, state);
      },
    };
  }

  private acquireImmediateSync(sessionId: string, holder?: string): SessionLockHandle {
    // Same as acquireImmediate but synchronous (no promise creation overhead)
    let resolveLock: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    const state: LockState = {
      promise,
      resolve: resolveLock!,
      acquiredAt: Date.now(),
      holder,
    };

    this.locks.set(sessionId, state);
    this.log(`Acquired lock (sync) for ${sessionId}`, holder);

    const warningTimer = setTimeout(() => {
      console.warn(
        `[SessionLockManager] Lock held for ${sessionId} > ${LOCK_HOLD_WARNING_MS}ms by ${holder ?? "unknown"}`
      );
    }, LOCK_HOLD_WARNING_MS);

    return {
      sessionId,
      acquiredAt: state.acquiredAt,
      release: () => {
        clearTimeout(warningTimer);
        this.release(sessionId, state);
      },
    };
  }

  private async acquireQueued(sessionId: string, holder?: string): Promise<SessionLockHandle> {
    // Get or create queue for this session
    let queue = this.waitingQueues.get(sessionId);
    if (!queue) {
      queue = [];
      this.waitingQueues.set(sessionId, queue);
    }

    // Check queue size limit to prevent memory exhaustion
    if (queue.length >= this.maxQueueSize) {
      this.queueFullRejections++;
      throw new Error(
        `Lock queue full for session ${sessionId} (max ${this.maxQueueSize} waiters)`
      );
    }

    this.log(`Queued for lock on ${sessionId}`, holder);

    return new Promise<SessionLockHandle>((resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        // Remove from queue
        const idx = queue!.indexOf(entry);
        if (idx !== -1) {
          queue!.splice(idx, 1);
        }
        if (queue!.length === 0) {
          this.waitingQueues.delete(sessionId);
        }

        this.timeoutCount++;
        this.log(`Timeout waiting for lock on ${sessionId}`, holder);
        reject(
          new Error(`Lock acquisition timeout for session ${sessionId} (${this.lockTimeoutMs}ms)`)
        );
      }, this.lockTimeoutMs);

      const entry = {
        resolve: (handle: SessionLockHandle) => {
          clearTimeout(timeoutId);
          resolve(handle);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      };

      queue!.push(entry);
    });
  }

  private release(sessionId: string, state: LockState): void {
    // Only release if this is the current lock holder (prevents double-release)
    if (this.locks.get(sessionId) !== state) {
      this.log(`Ignoring stale release for ${sessionId}`);
      return;
    }

    this.locks.delete(sessionId);
    this.log(`Released lock for ${sessionId}`, state.holder);

    // Wake up next waiter if any
    const queue = this.waitingQueues.get(sessionId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.waitingQueues.delete(sessionId);
      }

      // Give the lock to the next waiter
      const handle = this.acquireImmediateSync(sessionId, `from-queue:${state.holder}`);
      next.resolve(handle);
    }
  }

  private log(message: string, context?: string): void {
    if (this.debug) {
      console.error(`[SessionLockManager] ${message}${context ? ` (${context})` : ""}`);
    }
  }
}
