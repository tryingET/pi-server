/**
 * BoundedMap - A map with automatic TTL eviction and max-size trimming.
 *
 * This utility provides a unified pattern for maps that need:
 * - Time-based expiration (TTL)
 * - Size-based bounds (LRU trimming)
 *
 * Used for:
 * - Rate limit timestamp tracking
 * - Idempotency caches
 * - Any unbounded map that could grow indefinitely
 */

/**
 * Entry stored in the BoundedMap.
 */
interface BoundedEntry<V> {
  value: V;
  insertedAt: number;
  /** Insertion order for LRU eviction */
  order: number;
}

/**
 * Configuration for BoundedMap.
 */
export interface BoundedMapConfig {
  /** Maximum number of entries (0 = unlimited) */
  maxSize?: number;
  /** Time-to-live in milliseconds (0 = no TTL) */
  ttlMs?: number;
  /** Cleanup interval in milliseconds (default: 60000) */
  cleanupIntervalMs?: number;
}

/**
 * Statistics about the BoundedMap.
 */
export interface BoundedMapStats {
  /** Current number of entries */
  size: number;
  /** Maximum size (0 = unlimited) */
  maxSize: number;
  /** TTL in milliseconds (0 = no TTL) */
  ttlMs: number;
  /** Total entries evicted due to TTL */
  ttlEvictions: number;
  /** Total entries evicted due to size limit */
  sizeEvictions: number;
  /** Total manual deletions */
  deletions: number;
}

/**
 * A map with automatic TTL eviction and max-size trimming.
 *
 * Features:
 * - TTL-based expiration with automatic cleanup
 * - LRU-style eviction when maxSize is exceeded
 * - O(1) get/set operations
 * - Automatic periodic cleanup
 *
 * @example
 * ```typescript
 * // Rate limit timestamps with 1-minute TTL
 * const rateLimits = new BoundedMap<string[]>({
 *   ttlMs: 60000,
 *   maxSize: 10000,
 * });
 *
 * rateLimits.set('session-1', [Date.now()]);
 * const timestamps = rateLimits.get('session-1');
 * ```
 */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, BoundedEntry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly cleanupIntervalMs: number;

  private orderCounter = 0;
  private ttlEvictions = 0;
  private sizeEvictions = 0;
  private deletions = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: BoundedMapConfig = {}) {
    this.maxSize = config.maxSize ?? 0;
    this.ttlMs = config.ttlMs ?? 0;
    this.cleanupIntervalMs = config.cleanupIntervalMs ?? 60000;
  }

  /**
   * Get a value by key.
   * Returns undefined if key doesn't exist or entry has expired.
   */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (this.ttlMs > 0 && Date.now() - entry.insertedAt > this.ttlMs) {
      this.map.delete(key);
      this.ttlEvictions++;
      return undefined;
    }

    return entry.value;
  }

  /**
   * Set a value by key.
   * Evicts oldest entries if maxSize is exceeded.
   */
  set(key: K, value: V): void {
    const now = Date.now();

    // Check if entry exists (update vs insert)
    const existing = this.map.get(key);
    if (existing) {
      // Update existing entry
      this.map.set(key, {
        value,
        insertedAt: now,
        order: existing.order, // Keep original order for LRU semantics
      });
      return;
    }

    // Check TTL before insert (lazy cleanup)
    if (this.ttlMs > 0) {
      this.evictExpired(now);
    }

    // Check size limit before insert
    if (this.maxSize > 0 && this.map.size >= this.maxSize) {
      this.evictOldest();
    }

    // Insert new entry
    this.map.set(key, {
      value,
      insertedAt: now,
      order: ++this.orderCounter,
    });
  }

  /**
   * Check if a key exists (and hasn't expired).
   */
  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a key.
   */
  delete(key: K): boolean {
    const deleted = this.map.delete(key);
    if (deleted) {
      this.deletions++;
    }
    return deleted;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.map.clear();
  }

  /**
   * Get current size (includes expired entries until cleanup).
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Get statistics for monitoring.
   */
  getStats(): BoundedMapStats {
    return {
      size: this.map.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
      ttlEvictions: this.ttlEvictions,
      sizeEvictions: this.sizeEvictions,
      deletions: this.deletions,
    };
  }

  /**
   * Force cleanup of expired entries.
   * Returns count of evicted entries.
   */
  cleanup(): number {
    if (this.ttlMs === 0) return 0;
    return this.evictExpired(Date.now());
  }

  /**
   * Start periodic cleanup timer.
   */
  startPeriodicCleanup(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop periodic cleanup timer.
   */
  stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get all keys as an array (snapshot, safe for iteration).
   * Returns a copy to prevent mutation-during-iteration bugs.
   */
  keys(): K[] {
    return [...this.map.keys()];
  }

  /**
   * Get all values as an array (snapshot, safe for iteration).
   * Returns a copy with TTL-checked entries only.
   */
  values(): V[] {
    const result: V[] = [];
    const now = Date.now();
    for (const [key, entry] of this.map) {
      // Skip expired entries
      if (this.ttlMs > 0 && now - entry.insertedAt > this.ttlMs) {
        continue;
      }
      result.push(entry.value);
    }
    return result;
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  /**
   * Evict entries that have exceeded TTL.
   * Returns count of evicted entries.
   */
  private evictExpired(now: number): number {
    if (this.ttlMs === 0) return 0;

    const cutoff = now - this.ttlMs;
    let evicted = 0;

    for (const [key, entry] of this.map) {
      if (entry.insertedAt < cutoff) {
        this.map.delete(key);
        evicted++;
      }
    }

    this.ttlEvictions += evicted;
    return evicted;
  }

  /**
   * Evict oldest entries to make room.
   * Removes enough entries to get below maxSize.
   */
  private evictOldest(): void {
    if (this.maxSize === 0) return;

    // Sort by order (ascending = oldest first)
    const entries = [...this.map.entries()].sort((a, b) => a[1].order - b[1].order);

    // Remove oldest until we're under limit
    const toRemove = this.map.size - this.maxSize + 1;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      this.map.delete(entries[i][0]);
      this.sizeEvictions++;
    }
  }
}

/**
 * BoundedCounter - A specialized BoundedMap for rate limit counters.
 *
 * Stores arrays of timestamps with automatic TTL cleanup.
 * This is the pattern used by ResourceGovernor for rate limiting.
 *
 * @example
 * ```typescript
 * const counter = new BoundedCounter(60000, 10000); // 1-min TTL, max 10k sessions
 *
 * counter.record('session-1');
 * counter.record('session-1');
 *
 * const count = counter.countInWindow('session-1'); // 2
 * const isLimited = counter.checkAndRecord('session-1', 100); // false (under limit)
 * ```
 */
export class BoundedCounter<K = string> {
  private readonly map: BoundedMap<K, number[]>;
  private readonly windowMs: number;

  constructor(windowMs: number, maxKeys: number = 0) {
    this.windowMs = windowMs;
    this.map = new BoundedMap<K, number[]>({
      ttlMs: windowMs * 2, // Keep entries for 2x window to allow cleanup
      maxSize: maxKeys,
    });
  }

  /**
   * Record a timestamp for a key.
   */
  record(key: K): void {
    const timestamps = this.map.get(key) ?? [];
    timestamps.push(Date.now());
    this.map.set(key, timestamps);
  }

  /**
   * Count entries within the window for a key.
   */
  countInWindow(key: K): number {
    const timestamps = this.map.get(key);
    if (!timestamps) return 0;

    const cutoff = Date.now() - this.windowMs;
    return timestamps.filter((t) => t > cutoff).length;
  }

  /**
   * Check if count would exceed limit, and if not, record.
   * Returns true if recorded, false if limit exceeded.
   */
  checkAndRecord(key: K, limit: number): boolean {
    const count = this.countInWindow(key);
    if (count >= limit) {
      return false;
    }
    this.record(key);
    return true;
  }

  /**
   * Get current size.
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.map.clear();
  }

  /**
   * Delete a key.
   */
  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /**
   * Start periodic cleanup.
   */
  startPeriodicCleanup(): void {
    this.map.startPeriodicCleanup();
  }

  /**
   * Stop periodic cleanup.
   */
  stopPeriodicCleanup(): void {
    this.map.stopPeriodicCleanup();
  }
}
