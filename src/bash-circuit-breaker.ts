/**
 * Bash Circuit Breaker - prevents cascade failures from hung bash commands.
 *
 * Design doc: docs/design-bash-circuit-breaker.md
 *
 * Unlike LLM circuit breakers (where any error counts as failure),
 * bash commands only count TIMEOUT as failure. Non-zero exit codes
 * are often legitimate (e.g., `grep` returns 1 when no match).
 *
 * Hybrid protection:
 * - Per-session breaker: Isolates bad actors
 * - Global breaker: Backstop for distributed abuse
 *
 * Thresholds are more lenient than LLM:
 * - Session: 10 timeouts in 2 minutes
 * - Global: 50 timeouts in 2 minutes
 */

import { CircuitBreaker, type CircuitState } from "./circuit-breaker.js";

export interface BashCircuitBreakerConfig {
  /** Per-session failure threshold (default: 10) */
  sessionFailureThreshold: number;
  /** Global failure threshold (default: 50) */
  globalFailureThreshold: number;
  /** Successes needed to close circuit (default: 2) */
  successThreshold: number;
  /** Window for counting failures (default: 120000ms = 2 minutes) */
  windowMs: number;
  /** Time circuit stays open before half-open (default: 30000ms) */
  recoveryTimeoutMs: number;
  /** Maximum calls allowed in half-open state (default: 3) */
  halfOpenMaxCalls: number;
  /** Whether the circuit breaker is enabled (default: true) */
  enabled: boolean;
}

export const DEFAULT_BASH_CIRCUIT_CONFIG: BashCircuitBreakerConfig = {
  sessionFailureThreshold: 10,
  globalFailureThreshold: 50,
  successThreshold: 2,
  windowMs: 120_000, // 2 minutes
  recoveryTimeoutMs: 30_000, // 30 seconds
  halfOpenMaxCalls: 3,
  enabled: true,
};

export interface BashCircuitBreakerMetrics {
  enabled: boolean;
  globalState: CircuitState;
  globalFailureCount: number;
  sessionCount: number;
  openSessionCount: number;
  totalCalls: number;
  totalTimeouts: number;
  totalRejected: number;
}

/**
 * Bash Circuit Breaker - hybrid per-session + global protection.
 */
export class BashCircuitBreaker {
  private sessionBreakers = new Map<string, CircuitBreaker>();
  private globalBreaker: CircuitBreaker;
  private config: BashCircuitBreakerConfig;

  private totalCalls = 0;
  private totalTimeouts = 0;
  private totalRejected = 0;

  constructor(config: Partial<BashCircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_BASH_CIRCUIT_CONFIG, ...config };

    // Create global breaker with global threshold
    this.globalBreaker = new CircuitBreaker({
      providerName: "bash_global",
      latencyThresholdMs: Infinity, // Not used for bash (timeout is per-command)
      failureThreshold: this.config.globalFailureThreshold,
      failureWindowMs: this.config.windowMs,
      recoveryTimeoutMs: this.config.recoveryTimeoutMs,
      successThreshold: this.config.successThreshold,
      halfOpenMaxCalls: this.config.halfOpenMaxCalls,
    });
  }

  /**
   * Check if a bash command should be allowed.
   * Checks both session and global circuit breakers.
   */
  canExecute(sessionId: string): { allowed: true } | { allowed: false; reason: string } {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    this.totalCalls++;

    // Check session breaker first
    const sessionBreaker = this.getOrCreateSessionBreaker(sessionId);
    const sessionCheck = sessionBreaker.canExecute();

    if (!sessionCheck.allowed) {
      this.totalRejected++;
      return {
        allowed: false,
        reason: `Bash circuit breaker open for session ${sessionId}: ${sessionCheck.reason}`,
      };
    }

    // Check global breaker
    const globalCheck = this.globalBreaker.canExecute();

    if (!globalCheck.allowed) {
      this.totalRejected++;
      return {
        allowed: false,
        reason: `Bash circuit breaker open globally: ${globalCheck.reason}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a successful bash command (completed without timeout).
   * NOTE: Non-zero exit codes are NOT failures - they're often legitimate.
   */
  recordSuccess(sessionId: string): void {
    if (!this.config.enabled) return;

    // Record success on both breakers
    const sessionBreaker = this.getOrCreateSessionBreaker(sessionId);
    sessionBreaker.recordSuccess(0); // latency not relevant for bash
    this.globalBreaker.recordSuccess(0);
  }

  /**
   * Record a timeout (the ONLY failure mode for bash commands).
   * Non-zero exit codes should NOT call this - they're legitimate results.
   */
  recordTimeout(sessionId: string): void {
    if (!this.config.enabled) return;

    this.totalTimeouts++;

    // Record failure on both breakers
    const sessionBreaker = this.getOrCreateSessionBreaker(sessionId);
    sessionBreaker.recordFailure("timeout");
    this.globalBreaker.recordFailure("timeout");
  }

  /**
   * Record a spawn failure (ENOENT, EACCES, etc.).
   * These indicate system stress and should count as failures.
   */
  recordSpawnError(sessionId: string): void {
    if (!this.config.enabled) return;

    // Treat spawn errors like timeouts (system stress indicator)
    const sessionBreaker = this.getOrCreateSessionBreaker(sessionId);
    sessionBreaker.recordFailure("error");
    this.globalBreaker.recordFailure("error");
  }

  /**
   * Get current metrics for observability.
   */
  getMetrics(): BashCircuitBreakerMetrics {
    let openSessionCount = 0;
    for (const breaker of this.sessionBreakers.values()) {
      if (breaker.getState() === "open") {
        openSessionCount++;
      }
    }

    return {
      enabled: this.config.enabled,
      globalState: this.globalBreaker.getState(),
      globalFailureCount: this.globalBreaker.getMetrics().failureCount,
      sessionCount: this.sessionBreakers.size,
      openSessionCount,
      totalCalls: this.totalCalls,
      totalTimeouts: this.totalTimeouts,
      totalRejected: this.totalRejected,
    };
  }

  /**
   * Check if any circuit is open (for health checks).
   */
  hasOpenCircuit(): boolean {
    if (!this.config.enabled) return false;

    if (this.globalBreaker.getState() === "open") {
      return true;
    }

    for (const breaker of this.sessionBreakers.values()) {
      if (breaker.getState() === "open") {
        return true;
      }
    }

    return false;
  }

  /**
   * Reset all circuits (for admin operations).
   */
  resetAll(): void {
    this.globalBreaker.reset();
    for (const breaker of this.sessionBreakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Clean up stale session breakers.
   * Returns count of removed breakers.
   */
  cleanupStale(staleTimeoutMs = 60 * 60 * 1000): number {
    const cutoff = Date.now() - staleTimeoutMs;
    let removed = 0;

    for (const [sessionId, breaker] of this.sessionBreakers) {
      if (breaker.getLastAccessTime() < cutoff) {
        this.sessionBreakers.delete(sessionId);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get or create a circuit breaker for a session.
   */
  private getOrCreateSessionBreaker(sessionId: string): CircuitBreaker {
    let breaker = this.sessionBreakers.get(sessionId);
    if (!breaker) {
      breaker = new CircuitBreaker({
        providerName: `bash_session:${sessionId}`,
        latencyThresholdMs: Infinity, // Not used for bash
        failureThreshold: this.config.sessionFailureThreshold,
        failureWindowMs: this.config.windowMs,
        recoveryTimeoutMs: this.config.recoveryTimeoutMs,
        successThreshold: this.config.successThreshold,
        halfOpenMaxCalls: this.config.halfOpenMaxCalls,
      });
      this.sessionBreakers.set(sessionId, breaker);
    }
    return breaker;
  }

  /**
   * Update configuration at runtime.
   * Note: Does not affect existing breakers, only new ones.
   */
  updateConfig(config: Partial<BashCircuitBreakerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get session breaker count (for testing/debugging).
   */
  getSessionBreakerCount(): number {
    return this.sessionBreakers.size;
  }
}
