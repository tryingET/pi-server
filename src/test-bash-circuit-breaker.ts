/**
 * Tests for BashCircuitBreaker
 */

import assert from "assert";
import { BashCircuitBreaker, DEFAULT_BASH_CIRCUIT_CONFIG } from "./bash-circuit-breaker.js";

let testsPassed = 0;
let testsFailed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      console.log(`✅ ${name}`);
      testsPassed++;
    })
    .catch((err) => {
      console.log(`❌ ${name}: ${err.message}`);
      testsFailed++;
    });
}

async function runTests() {
  console.log("\n=== Bash Circuit Breaker Tests ===\n");

  await test("default config is sane", () => {
    assert.strictEqual(DEFAULT_BASH_CIRCUIT_CONFIG.sessionFailureThreshold, 10);
    assert.strictEqual(DEFAULT_BASH_CIRCUIT_CONFIG.globalFailureThreshold, 50);
    assert.strictEqual(DEFAULT_BASH_CIRCUIT_CONFIG.successThreshold, 2);
    assert.strictEqual(DEFAULT_BASH_CIRCUIT_CONFIG.enabled, true);
  });

  await test("allows execution when closed", () => {
    const breaker = new BashCircuitBreaker();
    const res = breaker.canExecute("s1");
    assert.strictEqual(res.allowed, true);
  });

  await test("session breaker opens after timeout threshold", () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 2,
      globalFailureThreshold: 100,
    });

    breaker.recordTimeout("s1");
    breaker.recordTimeout("s1");

    const blocked = breaker.canExecute("s1");
    assert.strictEqual(blocked.allowed, false);

    const other = breaker.canExecute("s2");
    assert.strictEqual(other.allowed, true);
  });

  await test("global breaker opens after timeout threshold", () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 100,
      globalFailureThreshold: 2,
    });

    breaker.recordTimeout("s1");
    breaker.recordTimeout("s2");

    const blocked = breaker.canExecute("s3");
    assert.strictEqual(blocked.allowed, false);
    assert.ok((blocked as { reason?: string }).reason?.includes("globally"));
  });

  await test("open breaker transitions to half-open after recovery timeout", async () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 2,
      globalFailureThreshold: 100,
      recoveryTimeoutMs: 40,
      successThreshold: 1,
    });

    breaker.recordTimeout("s1");
    breaker.recordTimeout("s1");
    assert.strictEqual(breaker.canExecute("s1").allowed, false);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const halfOpenProbe = breaker.canExecute("s1");
    assert.strictEqual(halfOpenProbe.allowed, true);

    breaker.recordSuccess("s1");
    assert.strictEqual(breaker.canExecute("s1").allowed, true);
  });

  await test("spawn errors count as failures", () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 2,
      globalFailureThreshold: 100,
    });

    breaker.recordSpawnError("s1");
    breaker.recordSpawnError("s1");

    assert.strictEqual(breaker.canExecute("s1").allowed, false);
  });

  await test("cleanup removes stale session breakers", async () => {
    const breaker = new BashCircuitBreaker();
    breaker.canExecute("s1");
    breaker.canExecute("s2");

    await new Promise((resolve) => setTimeout(resolve, 25));
    const removed = breaker.cleanupStale(10);

    assert.strictEqual(removed, 2);
    assert.strictEqual(breaker.getSessionBreakerCount(), 0);
  });

  await test("metrics are reported", () => {
    const breaker = new BashCircuitBreaker({
      sessionFailureThreshold: 2,
      globalFailureThreshold: 100,
    });

    breaker.canExecute("s1");
    breaker.recordTimeout("s1");
    breaker.recordTimeout("s1");
    breaker.canExecute("s1"); // rejected

    const metrics = breaker.getMetrics();
    assert.strictEqual(metrics.totalTimeouts, 2);
    assert.ok(metrics.totalCalls >= 2);
    assert.ok(metrics.totalRejected >= 1);
    assert.strictEqual(metrics.openSessionCount >= 1, true);
  });
}

async function main() {
  console.log("🧪 BashCircuitBreaker Tests\n");
  await runTests();

  console.log("\n==================================================");
  console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
