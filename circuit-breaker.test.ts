/**
 * Tests for Circuit Breaker (ADR-0010)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerManager,
  DEFAULT_CIRCUIT_CONFIG,
  type CircuitBreakerConfig,
} from "./src/circuit-breaker.js";

// Fast test config
const TEST_CONFIG: Omit<CircuitBreakerConfig, "providerName"> = {
  latencyThresholdMs: 100,
  failureThreshold: 3,
  failureWindowMs: 1000,
  recoveryTimeoutMs: 100,
  successThreshold: 2,
  halfOpenMaxCalls: 3,
};

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      ...TEST_CONFIG,
      providerName: "test-provider",
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("closed state", () => {
    it("allows all calls initially", () => {
      expect(breaker.canExecute()).toEqual({ allowed: true });
      expect(breaker.canExecute()).toEqual({ allowed: true });
    });

    it("stays closed on successful fast calls", () => {
      for (let i = 0; i < 10; i++) {
        expect(breaker.canExecute()).toEqual({ allowed: true });
        breaker.recordSuccess(50);
      }
      expect(breaker.getState()).toBe("closed");
    });

    it("opens after failure threshold reached", () => {
      expect(breaker.getState()).toBe("closed");

      // Record failures up to threshold
      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        expect(breaker.canExecute()).toEqual({ allowed: true });
        breaker.recordFailure("error");
      }

      expect(breaker.getState()).toBe("open");
    });

    it("counts slow calls as degradation signal (but not as failure)", () => {
      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        breaker.canExecute();
        breaker.recordSuccess(200); // Over threshold
      }
      expect(breaker.getState()).toBe("open");

      // Slow calls should be tracked separately
      const metrics = breaker.getMetrics();
      expect(metrics.totalSlowCalls).toBe(TEST_CONFIG.failureThreshold);
      expect(metrics.totalFailures).toBe(0); // NOT double-counted
    });

    it("tracks last access time on canExecute", () => {
      const before = breaker.getLastAccessTime();
      vi.advanceTimersByTime(100);
      breaker.canExecute();
      const after = breaker.getLastAccessTime();
      expect(after).toBeGreaterThan(before);
    });

    it("tracks last access time on recordSuccess", () => {
      breaker.canExecute();
      const before = breaker.getLastAccessTime();
      vi.advanceTimersByTime(100);
      breaker.recordSuccess(50);
      const after = breaker.getLastAccessTime();
      expect(after).toBeGreaterThan(before);
    });
  });

  describe("open state", () => {
    beforeEach(() => {
      // Force open
      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        breaker.recordFailure("error");
      }
      expect(breaker.getState()).toBe("open");
    });

    it("rejects calls while open", () => {
      const result = breaker.canExecute();
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("Circuit open");
        expect(result.state).toBe("open");
      }
    });

    it("transitions to half-open after recovery timeout", () => {
      vi.advanceTimersByTime(TEST_CONFIG.recoveryTimeoutMs);

      const result = breaker.canExecute();
      expect(result.allowed).toBe(true);
      expect(breaker.getState()).toBe("half_open");
    });

    it("increments rejected count", () => {
      breaker.canExecute();
      breaker.canExecute();
      const metrics = breaker.getMetrics();
      expect(metrics.totalRejected).toBe(2);
    });
  });

  describe("half-open state", () => {
    beforeEach(() => {
      // Force open then wait for recovery
      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        breaker.recordFailure("error");
      }
      vi.advanceTimersByTime(TEST_CONFIG.recoveryTimeoutMs);
      breaker.canExecute(); // Triggers half-open
      expect(breaker.getState()).toBe("half_open");
    });

    it("closes after success threshold", () => {
      for (let i = 0; i < TEST_CONFIG.successThreshold; i++) {
        breaker.canExecute();
        breaker.recordSuccess(50);
      }
      expect(breaker.getState()).toBe("closed");
    });

    it("reopens on any failure", () => {
      breaker.recordFailure("error");
      expect(breaker.getState()).toBe("open");
    });

    it("resets success count on failure", () => {
      breaker.recordSuccess(50); // 1 success
      breaker.recordFailure("error"); // Reopens
      expect(breaker.getState()).toBe("open");

      // Wait for recovery again
      vi.advanceTimersByTime(TEST_CONFIG.recoveryTimeoutMs);
      breaker.canExecute();
      expect(breaker.getState()).toBe("half_open");

      // Should need full success threshold again
      breaker.recordSuccess(50);
      expect(breaker.getState()).toBe("half_open"); // Not closed yet
    });

    it("limits calls in half-open state", () => {
      // Exhaust half-open call limit
      for (let i = 0; i < TEST_CONFIG.halfOpenMaxCalls; i++) {
        const result = breaker.canExecute();
        expect(result.allowed).toBe(true);
      }

      // Next call should be rejected
      const result = breaker.canExecute();
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("max test calls reached");
      }
    });

    it("resets half-open call count on transition to closed", () => {
      breaker.canExecute();
      breaker.canExecute();
      expect(breaker.getMetrics().halfOpenCalls).toBe(2);

      // Close the circuit
      for (let i = 0; i < TEST_CONFIG.successThreshold; i++) {
        breaker.canExecute();
        breaker.recordSuccess(50);
      }
      expect(breaker.getState()).toBe("closed");

      // Verify counter was reset
      expect(breaker.getMetrics().halfOpenCalls).toBe(0);
    });
  });

  describe("metrics", () => {
    it("tracks total calls", () => {
      breaker.canExecute();
      breaker.canExecute();
      expect(breaker.getMetrics().totalCalls).toBe(2);
    });

    it("tracks successes and failures separately", () => {
      breaker.canExecute();
      breaker.recordSuccess(50);
      breaker.canExecute();
      breaker.recordFailure("error");

      const metrics = breaker.getMetrics();
      expect(metrics.totalSuccesses).toBe(1);
      expect(metrics.totalFailures).toBe(1);
    });

    it("tracks slow calls separately from failures", () => {
      breaker.canExecute();
      breaker.recordSuccess(200); // Slow
      breaker.canExecute();
      breaker.recordFailure("error");

      const metrics = breaker.getMetrics();
      expect(metrics.totalSlowCalls).toBe(1);
      expect(metrics.totalFailures).toBe(1); // NOT 2
    });

    it("calculates average latency", () => {
      breaker.canExecute();
      breaker.recordSuccess(100);
      breaker.canExecute();
      breaker.recordSuccess(200);
      expect(breaker.getMetrics().avgLatencyMs).toBe(150);
    });
  });

  describe("reset", () => {
    it("resets to closed state", () => {
      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        breaker.recordFailure("error");
      }
      expect(breaker.getState()).toBe("open");

      breaker.reset();

      expect(breaker.getState()).toBe("closed");
      expect(breaker.canExecute()).toEqual({ allowed: true });
    });

    it("resets half-open call count", () => {
      // Open and go to half-open
      for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
        breaker.recordFailure("error");
      }
      vi.advanceTimersByTime(TEST_CONFIG.recoveryTimeoutMs);
      breaker.canExecute();

      breaker.reset();
      expect(breaker.getMetrics().halfOpenCalls).toBe(0);
    });
  });

  describe("pruneFailures", () => {
    it("can be called externally for proactive cleanup", () => {
      breaker.recordFailure("error");
      breaker.recordFailure("error");

      // Wait for window to expire
      vi.advanceTimersByTime(TEST_CONFIG.failureWindowMs + 100);

      breaker.pruneFailures();

      expect(breaker.getMetrics().failureCount).toBe(0);
    });
  });
});

describe("CircuitBreakerManager", () => {
  let manager: CircuitBreakerManager;

  beforeEach(() => {
    manager = new CircuitBreakerManager(TEST_CONFIG);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates breakers on demand", () => {
    const b1 = manager.getBreaker("provider-a");
    const b2 = manager.getBreaker("provider-b");

    expect(b1).not.toBe(b2);
  });

  it("returns same breaker for same provider", () => {
    const b1 = manager.getBreaker("provider-a");
    const b2 = manager.getBreaker("provider-a");

    expect(b1).toBe(b2);
  });

  it("removes breakers", () => {
    manager.getBreaker("provider-a");
    expect(manager.getBreakerCount()).toBe(1);

    const removed = manager.removeBreaker("provider-a");
    expect(removed).toBe(true);
    expect(manager.getBreakerCount()).toBe(0);

    // Removing non-existent returns false
    expect(manager.removeBreaker("nonexistent")).toBe(false);
  });

  it("collects metrics from all breakers", () => {
    const b1 = manager.getBreaker("provider-a");
    const b2 = manager.getBreaker("provider-b");

    b1.recordFailure("error");
    b1.recordFailure("error");
    b1.recordFailure("error"); // Open

    b2.recordSuccess(50);

    const metrics = manager.getAllMetrics();
    expect(metrics).toHaveLength(2);
    expect(metrics.find((m) => m.providerName === "provider-a")?.state).toBe("open");
    expect(metrics.find((m) => m.providerName === "provider-b")?.state).toBe("closed");
  });

  it("detects open circuits", () => {
    const b1 = manager.getBreaker("provider-a");
    expect(manager.hasOpenCircuit()).toBe(false);

    b1.recordFailure("error");
    b1.recordFailure("error");
    b1.recordFailure("error");
    expect(manager.hasOpenCircuit()).toBe(true);
  });

  it("resets all breakers", () => {
    const b1 = manager.getBreaker("provider-a");
    const b2 = manager.getBreaker("provider-b");

    for (let i = 0; i < TEST_CONFIG.failureThreshold; i++) {
      b1.recordFailure("error");
      b2.recordFailure("error");
    }

    expect(b1.getState()).toBe("open");
    expect(b2.getState()).toBe("open");

    manager.resetAll();

    expect(b1.getState()).toBe("closed");
    expect(b2.getState()).toBe("closed");
  });

  it("cleans up stale breakers", () => {
    // Create breakers AFTER fake timers are set (in beforeEach)
    vi.advanceTimersByTime(0); // Sync to fake time t=0

    const b1 = manager.getBreaker("provider-a");
    vi.advanceTimersByTime(1000);
    const b2 = manager.getBreaker("provider-b");

    // Access b1 recently (at t=2000)
    vi.advanceTimersByTime(1000);
    b1.canExecute(); // b1 lastAccess = t=2000, b2 lastAccess = t=1000

    // Move to t = 1 hour + 3000ms
    // Cutoff = t - 1 hour = 3000
    // b1 (2000 < 3000) -> stale, b2 (1000 < 3000) -> stale
    // Wait, we want b1 to be fresh. Let's access b1 later.
    vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour, now at t = 1hr + 2000

    // Access b1 again to make it fresh
    b1.canExecute(); // b1 lastAccess = t = 1hr + 2000

    // Now move forward 1 more second
    vi.advanceTimersByTime(1000); // t = 1hr + 3000

    // Cutoff = 1hr + 3000 - 1hr = 3000
    // b1 lastAccess = 1hr + 2000 < 1hr + 3000 - 1hr = 3000... wait that's still < 3000
    // Actually: cutoff = now - staleTimeout = (1hr + 3000) - 1hr = 3000
    // b1 lastAccess = 1hr + 2000, which is > 3000, so NOT stale
    // b2 lastAccess = 1000, which is < 3000, so stale

    const removed = manager.cleanupStaleBreakers();
    expect(removed).toBe(1);
    expect(manager.getBreakerCount()).toBe(1);
    expect(manager.getBreaker("provider-a")).toBe(b1); // Still exists
  });

  it("prunes failures in all breakers", () => {
    const b1 = manager.getBreaker("provider-a");
    const b2 = manager.getBreaker("provider-b");

    b1.recordFailure("error");
    b2.recordFailure("error");

    vi.advanceTimersByTime(TEST_CONFIG.failureWindowMs + 100);

    manager.pruneAllFailures();

    expect(b1.getMetrics().failureCount).toBe(0);
    expect(b2.getMetrics().failureCount).toBe(0);
  });

  it("reports breaker count", () => {
    expect(manager.getBreakerCount()).toBe(0);
    manager.getBreaker("a");
    expect(manager.getBreakerCount()).toBe(1);
    manager.getBreaker("b");
    expect(manager.getBreakerCount()).toBe(2);
  });
});

describe("CircuitBreaker integration scenarios", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles intermittent failures without opening", () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      ...TEST_CONFIG,
      providerName: "flaky-provider",
    });

    // Scattered failures below threshold
    breaker.recordFailure("error");
    breaker.recordSuccess(50);
    vi.advanceTimersByTime(500);
    breaker.recordFailure("error");
    breaker.recordSuccess(50);

    expect(breaker.getState()).toBe("closed");
  });

  it("prunes old failures outside window", () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      ...TEST_CONFIG,
      providerName: "test",
    });

    // Record failures
    breaker.recordFailure("error");
    breaker.recordFailure("error");

    // Wait for window to expire
    vi.advanceTimersByTime(TEST_CONFIG.failureWindowMs + 100);

    // Record one more failure - old ones should be pruned
    breaker.recordFailure("error");

    // Only 1 failure in window, should still be closed
    expect(breaker.getState()).toBe("closed");
  });

  it("slow calls and failures both contribute to opening", () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      ...TEST_CONFIG,
      providerName: "test",
    });

    // Mix of slow calls and errors
    breaker.recordSuccess(200); // slow
    breaker.recordFailure("error");
    breaker.recordSuccess(200); // slow

    // Should open (3 total degradation signals)
    expect(breaker.getState()).toBe("open");
    expect(breaker.getMetrics().totalSlowCalls).toBe(2);
    expect(breaker.getMetrics().totalFailures).toBe(1);
  });
});
