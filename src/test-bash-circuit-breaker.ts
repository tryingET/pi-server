/**
 * Tests for BashCircuitBreaker
 */

import assert from "assert";
import {
  BashCircuitBreaker,
  DEFAULT_BASH_CIRCUIT_CONFIG,
} from "./bash-circuit-breaker.js";

// =============================================================================
// TEST UTILITIES
// =============================================================================

let testsPassed = 0;
let testsFailed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      console.log("[PASS] " + name);
      testsPassed++;
    })
    .catch((err) => {
      console.log("[FAIL] " + name + ": " + err.message);
      testsFailed++;
    });
}

// =============================================================================
// CONFIG TESTS
// =============================================================================

async function testConfig() {
  console.log("\n=== Config Tests ===\n");

  await test("has default config", () => {
    const config = DEFAULT_BASH_CIRCUIT_CONFIG;
    assert.strictEqual(config.sessionFailureThreshold, 10);
    assert.strictEqual(config.globalFailureThreshold, 50);
    assert.strictEqual(config.successThreshold, 2);
    assert.strictEqual(config.windowMs, 120000);
    assert.strictEqual(config.recoveryTimeoutMs, 30000);
    assert.strictEqual(config.enabled, true);
  });

  await test("accepts partial config", () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 5,
      globalFailureThreshold: 20,
      enabled: true,
    });
    const metrics = breaker.getMetrics();
    assert.strictEqual(metrics.enabled, true);
  });

  await test("can be disabled", () => {
    const breaker = new BashCircuitBreaker({ enabled: false });
    assert.strictEqual(breaker.canExecute("session-1").allowed, true);
    assert.strictEqual(breaker.canExecute("session-2").allowed, true);

    // Record should be no-ops when disabled
    breaker.recordTimeout("session-1");
    breaker.recordTimeout("session-2");

    const metrics = breaker.getMetrics();
    assert.strictEqual(metrics.enabled, false);
  });
}

// =============================================================================
// CAN EXECUTE TESTS
// =============================================================================

async function testCanExecute() {
  console.log("\n=== CanExecute Tests ===\n");

  await test("allows execution when circuits closed", () => {
    const breaker = new BashCircuitBreaker();
    assert.deepStrictEqual(breaker.canExecute("session-1"), { allowed: true });
    assert.deepStrictEqual(breaker.canExecute("session-2"), { allowed: true });
  });

  await test("rejects when session circuit open", () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 3,
    });
    // Trigger session circuit open
    breaker.recordTimeout("session-1");
    breaker.recordTimeout("session-1");
    breaker.recordTimeout("session-1");
    const result = breaker.canExecute("session-1");
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes("session session-1"));

    // Other sessions should still work
    const otherResult = breaker.canExecute("session-2");
    assert.strictEqual(otherResult.allowed, true);
  });

  await test("rejects when global circuit open", () => {
    const breaker = new BashCircuitBreaker({
      globalFailureThreshold: 3,
    });
    // Trigger global circuit open
    breaker.recordTimeout("session-1");
    breaker.recordTimeout("session-2");
    breaker.recordTimeout("session-3");
    const result1 = breaker.canExecute("session-4");
    assert.strictEqual(result1.allowed, false);
    assert.ok(result1.reason.includes("globally"));

    // All sessions rejected when global is open
    const result2 = breaker.canExecute("session-1");
    assert.strictEqual(result2.allowed, false);
  });
}

// =============================================================================
// CIRCUIT STATE TESTS
// =============================================================================

async function testCircuitState() {
  console.log("\n=== Circuit State Tests ===\n");

  await test("circuit opens after threshold timeouts", () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 2,
    });
    breaker.recordTimeout("s1");
    breaker.recordTimeout("s1");
    const result = breaker.canExecute("s1");
    assert.strictEqual(result.allowed, false);
  });

  await test("circuit requires recovery time before half-open", async () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 2,
      recoveryTimeoutMs: 100, // 100ms recovery
    });
    breaker.recordTimeout("s1");
    breaker.recordTimeout("s1");
    assert.strictEqual(breaker.canExecute("s1").allowed, false);

    // Wait for recovery
    await new Promise(r => setTimeout(r, 150));

    // Now should be half-open (allowed)
    const result = breaker.canExecute("s1");
    assert.strictEqual(result.allowed, true);
  });

  await test("success in half-open closes circuit", async () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 2,
      recoveryTimeoutMs: 50,
      successThreshold: 1,
    });
    breaker.recordTimeout("s1");
    breaker.recordTimeout("s1");
    assert.strictEqual(breaker.canExecute("s1").allowed, false);

    // Wait for recovery
    await new Promise(r => setTimeout(r, 100));

    // Now in half-open - this call is allowed
    assert.strictEqual(breaker.canExecute("s1").allowed, true);

    // Record success to close
    breaker.recordSuccess("s1");
    assert.strictEqual(breaker.canExecute("s1").allowed, true);
  });
}

// =============================================================================
// METRICS TESTS
// =============================================================================

async function testMetrics() {
  console.log("\n=== Metrics Tests ===\n");

  await test("tracks metrics correctly", () => {
    const breaker = new BashCircuitBreaker();
    breaker.canExecute("session-1");
    breaker.canExecute("session-2");
    breaker.canExecute("session-1");

    const metrics = breaker.getMetrics();
    assert.strictEqual(metrics.enabled, true);
    assert.strictEqual(metrics.sessionCount, 2);
    assert.strictEqual(metrics.totalCalls, 3);
    assert.strictEqual(metrics.totalRejected, 0);
    assert.strictEqual(metrics.totalTimeouts, 0);
  });

  await test("tracks timeouts and () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 2,
    });
    breaker.canExecute("session-1");
    breaker.recordTimeout("session-1");
    breaker.recordTimeout("session-1");
    const metrics = breaker.getMetrics();
    assert.strictEqual(metrics.totalTimeouts, 2);
  });
}

// =============================================================================
// CLEANUP TESTS
// =============================================================================

async function testCleanup() {
  console.log("\n=== Cleanup Tests ===\n");

  await test("cleanup removes stale breakers", async () => {
    const breaker = new BashCircuitBreaker();

    // Create breakers
    breaker.canExecute("session-1");
    breaker.canExecute("session-2");

    // Wait a bit so they become stale
    await new Promise(r => setTimeout(r, 50));

    // Clean up with short timeout
    const removed = breaker.cleanupStale(10); // 10ms - should remove both
    assert.strictEqual(removed, 2);
    assert.strictEqual(breaker.getSessionBreakerCount(), 0);
  });
}

// =============================================================================
// SPAWN ERROR TEST
// =============================================================================

async function testSpawnError() {
  console.log("\n=== Spawn Error Tests ===\n");

  await test("spawn error counts as failure", () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 2,
    });

    breaker.recordSpawnError("session-1");
    breaker.recordSpawnError("session-1");
    const result = breaker.canExecute("session-1");
    assert.strictEqual(result.allowed, false);
  });
}

// =============================================================================
// RUN
// =============================================================================

async function main() {
  console.log("BashCircuitBreaker Tests\n");

  await testConfig();
  await testCanExecute();
  await testCircuitState();
  await testMetrics();
  await testCleanup();
  await testSpawnError();

  console.log("\n==================================================");
  console.log("Results: " + testsPassed + " passed, " + testsFailed + " failed");

  if (testsFailed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
