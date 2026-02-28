/**
 * Circuit Breaker - prevents cascade failures from slow/failing LLM providers.
 *
 * ADR-0010: Circuit Breaker for LLM Calls
 *
 * The circuit breaker pattern prevents a failing dependency from taking down
 * the entire system. When LLM calls exceed latency thresholds or fail repeatedly,
 * the circuit opens and fast-fails subsequent calls until recovery.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failing, requests are rejected immediately
 * - HALF_OPEN: Testing recovery, limited requests allowed
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /** Maximum latency before considering call "slow" (ms) */
  latencyThresholdMs: number;
  /** Number of slow/failing calls before opening circuit */
  failureThreshold: number;
  /** Time window for counting failures (ms) */
  failureWindowMs: number;
  /** Time to wait before attempting recovery (ms) */
  recoveryTimeoutMs: number;
  /** Number of successful calls in half-open to close circuit */
  successThreshold: number;
  /** Maximum calls allowed in half-open state per recovery window (default: 5) */
  halfOpenMaxCalls: number;
  /** Provider name for logging/metrics */
  providerName: string;
}

export const DEFAULT_CIRCUIT_CONFIG: Omit<CircuitBreakerConfig, "providerName"> = {
  latencyThresholdMs: 30_000, // 30 seconds
  failureThreshold: 5,
  failureWindowMs: 60_000, // 1 minute
  recoveryTimeoutMs: 30_000, // 30 seconds
  successThreshold: 2,
  halfOpenMaxCalls: 5,
};

interface FailureRecord {
  timestamp: number;
  type: "timeout" | "error" | "slow";
}

export interface CircuitBreakerMetrics {
  providerName: string;
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number | null;
  lastStateChange: number;
  lastAccessTime: number;
  totalCalls: number;
  totalRejected: number;
  totalSlowCalls: number;
  totalSuccesses: number;
  totalFailures: number;
  avgLatencyMs: number;
  halfOpenCalls: number;
}

/** Time before unused breaker is considered stale (1 hour) */
const STALE_BREAKER_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Circuit breaker for a single LLM provider.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures: FailureRecord[] = [];
  private lastStateChange: number = Date.now();
  private lastAccessTime: number = Date.now();
  private halfOpenSuccesses = 0;
  private halfOpenCalls = 0;

  private totalCalls = 0;
  private totalRejected = 0;
  private totalSuccesses = 0;
  private totalSlowCalls = 0;
  private totalFailures = 0;
  private latencySum = 0;

  constructor(private config: CircuitBreakerConfig) {}

  /**
   * Check if a call should be allowed through the circuit.
   * Returns result with state for logging/metrics.
   */
  canExecute(): { allowed: true } | { allowed: false; reason: string; state: CircuitState } {
    this.totalCalls++;
    this.lastAccessTime = Date.now();

    // Clean up old failures outside the window
    this.pruneFailures();

    switch (this.state) {
      case "closed":
        return { allowed: true };

      case "open": {
        // Check if recovery timeout has passed
        const timeSinceOpen = Date.now() - this.lastStateChange;
        if (timeSinceOpen >= this.config.recoveryTimeoutMs) {
          this.transitionTo("half_open");
          return { allowed: true };
        }
        this.totalRejected++;
        return {
          allowed: false,
          reason: `Circuit open for ${this.config.providerName} (recovery in ${Math.ceil((this.config.recoveryTimeoutMs - timeSinceOpen) / 1000)}s)`,
          state: "open",
        };
      }

      case "half_open": {
        // Limit calls in half-open state to prevent overwhelming recovering provider
        if (this.halfOpenCalls >= this.config.halfOpenMaxCalls) {
          this.totalRejected++;
          return {
            allowed: false,
            reason: `Circuit half-open, max test calls reached for ${this.config.providerName}`,
            state: "half_open",
          };
        }
        this.halfOpenCalls++;
        return { allowed: true };
      }
    }
  }

  /**
   * Record a successful call.
   * Note: Slow calls are tracked separately and contribute to failure count,
   * but do NOT increment totalFailures (to avoid double-counting).
   */
  recordSuccess(latencyMs: number): void {
    this.totalSuccesses++;
    this.latencySum += latencyMs;
    this.lastAccessTime = Date.now();

    // Track slow calls as degradation signal (but don't double-count as failure)
    if (latencyMs > this.config.latencyThresholdMs) {
      this.totalSlowCalls++;
      this.failures.push({
        timestamp: Date.now(),
        type: "slow",
      });
      this.pruneFailures();

      // Check if slow calls should open the circuit
      if (this.state === "closed" && this.failures.length >= this.config.failureThreshold) {
        this.transitionTo("open");
      }
      return;
    }

    if (this.state === "half_open") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.successThreshold) {
        this.transitionTo("closed");
      }
    }

    // In closed state, clear old failures on success
    if (this.state === "closed") {
      this.pruneFailures();
    }
  }

  /**
   * Record a failed call (error or timeout).
   */
  recordFailure(type: "timeout" | "error"): void {
    this.totalFailures++;
    this.lastAccessTime = Date.now();

    this.failures.push({
      timestamp: Date.now(),
      type,
    });

    this.pruneFailures();

    if (this.state === "half_open") {
      // Any failure in half-open immediately reopens
      this.transitionTo("open");
      return;
    }

    if (this.state === "closed" && this.failures.length >= this.config.failureThreshold) {
      this.transitionTo("open");
    }
  }

  /**
   * Get current circuit state.
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get last access time (for stale detection).
   */
  getLastAccessTime(): number {
    return this.lastAccessTime;
  }

  /**
   * Get current metrics for observability.
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      providerName: this.config.providerName,
      state: this.state,
      failureCount: this.failures.length,
      lastFailureTime:
        this.failures.length > 0 ? this.failures[this.failures.length - 1].timestamp : null,
      lastStateChange: this.lastStateChange,
      lastAccessTime: this.lastAccessTime,
      totalCalls: this.totalCalls,
      totalRejected: this.totalRejected,
      totalSlowCalls: this.totalSlowCalls,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      avgLatencyMs: this.totalCalls > 0 ? Math.round(this.latencySum / this.totalCalls) : 0,
      halfOpenCalls: this.halfOpenCalls,
    };
  }

  /**
   * Force reset the circuit (for admin operations).
   */
  reset(): void {
    this.failures = [];
    this.halfOpenSuccesses = 0;
    this.halfOpenCalls = 0;
    this.transitionTo("closed");
  }

  /**
   * Prune failures outside the window.
   * Called internally, but also safe to call externally for proactive cleanup.
   */
  pruneFailures(): void {
    const cutoff = Date.now() - this.config.failureWindowMs;
    this.failures = this.failures.filter((f) => f.timestamp > cutoff);
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;

    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();

    if (newState === "closed") {
      this.failures = [];
      this.halfOpenSuccesses = 0;
      this.halfOpenCalls = 0;
    }

    if (newState === "half_open") {
      this.halfOpenSuccesses = 0;
      this.halfOpenCalls = 0;
    }

    console.error(`[CircuitBreaker] ${this.config.providerName}: ${oldState} -> ${newState}`);
  }
}

/**
 * Manager for multiple circuit breakers (one per LLM provider).
 * Includes cleanup for stale breakers to prevent unbounded memory growth.
 */
export class CircuitBreakerManager {
  private breakers = new Map<string, CircuitBreaker>();
  private defaultConfig: Omit<CircuitBreakerConfig, "providerName">;

  constructor(defaultConfig: Partial<Omit<CircuitBreakerConfig, "providerName">> = {}) {
    this.defaultConfig = {
      ...DEFAULT_CIRCUIT_CONFIG,
      ...defaultConfig,
    };
  }

  /**
   * Get or create a circuit breaker for a provider.
   */
  getBreaker(providerName: string): CircuitBreaker {
    let breaker = this.breakers.get(providerName);
    if (!breaker) {
      breaker = new CircuitBreaker({
        ...this.defaultConfig,
        providerName,
      });
      this.breakers.set(providerName, breaker);
    }
    return breaker;
  }

  /**
   * Remove a circuit breaker (for cleanup or admin operations).
   */
  removeBreaker(providerName: string): boolean {
    return this.breakers.delete(providerName);
  }

  /**
   * Get all circuit breaker metrics.
   */
  getAllMetrics(): CircuitBreakerMetrics[] {
    return Array.from(this.breakers.values()).map((b) => b.getMetrics());
  }

  /**
   * Check if any circuit is open (for health checks).
   */
  hasOpenCircuit(): boolean {
    return Array.from(this.breakers.values()).some((b) => b.getState() === "open");
  }

  /**
   * Reset all circuits.
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Clean up stale breakers that haven't been accessed in a while.
   * Returns count of removed breakers.
   */
  cleanupStaleBreakers(staleTimeoutMs = STALE_BREAKER_TIMEOUT_MS): number {
    const cutoff = Date.now() - staleTimeoutMs;
    let removed = 0;

    for (const [name, breaker] of this.breakers) {
      if (breaker.getLastAccessTime() < cutoff) {
        this.breakers.delete(name);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get count of managed breakers.
   */
  getBreakerCount(): number {
    return this.breakers.size;
  }

  /**
   * Prune failures in all breakers (proactive cleanup).
   */
  pruneAllFailures(): void {
    for (const breaker of this.breakers.values()) {
      breaker.pruneFailures();
    }
  }
}
