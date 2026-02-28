/**
 * Tests for ThresholdAlertSink.
 *
 * Run with: node --experimental-vm-modules dist/test-threshold-alert-sink.js
 */

import assert from "assert";

// =============================================================================
// TEST UTILITIES
// =============================================================================

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

// =============================================================================
// IMPORTS
// =============================================================================

import { ThresholdAlertSink } from "./threshold-alert-sink.js";
import { MemorySink, NoOpSink } from "./metrics-types.js";
import type { MetricEvent } from "./metrics-types.js";

// =============================================================================
// TESTS
// =============================================================================

async function runTests() {
  console.log("\n=== ThresholdAlertSink Tests ===\n");

  let alertHandlerCalls: Array<{ metricName: string; value: number; level: string; threshold: number }> = [];
  let clearHandlerCalls: Array<{ metricName: string; value: number }> = [];
  let memorySink: MemorySink;
  let alertSink: ThresholdAlertSink;

  function reset() {
    alertHandlerCalls = [];
    clearHandlerCalls = [];
    memorySink = new MemorySink();
    alertSink = new ThresholdAlertSink({
      sink: memorySink,
      thresholds: {
        test_metric: { warn: 50, critical: 100, info: 25 },
      },
      onAlert: (alert) => {
        alertHandlerCalls.push({
          metricName: alert.metricName,
          value: alert.value,
          level: alert.level,
          threshold: alert.threshold,
        });
      },
      onClear: (alert) => {
        clearHandlerCalls.push({
          metricName: alert.metricName,
          value: alert.value,
        });
      },
    });
  }

  const waitForAsync = () => new Promise((resolve) => setTimeout(resolve, 10));

  // ==========================================================================
  // PASS-THROUGH
  // ==========================================================================

  await test("passes metrics through to underlying sink", () => {
    reset();
    const event: MetricEvent = { name: "test_metric", type: "gauge", value: 10 };
    alertSink.record(event);

    const metrics = memorySink.getMetrics();
    const gauges = metrics.gauges as Record<string, number | undefined>;
    assert.strictEqual(gauges.test_metric, 10);
  });

  await test("passes unwatched metrics through without alerting", async () => {
    reset();
    const event: MetricEvent = { name: "unwatched_metric", type: "gauge", value: 999 };
    alertSink.record(event);
    await waitForAsync();

    assert.strictEqual(alertHandlerCalls.length, 0);
    const metrics = memorySink.getMetrics();
    const gauges = metrics.gauges as Record<string, number | undefined>;
    assert.strictEqual(gauges.unwatched_metric, 999);
  });

  // ==========================================================================
  // THRESHOLD CROSSING
  // ==========================================================================

  await test("fires info alert when crossing info threshold", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: 30 });
    await waitForAsync();

    assert.strictEqual(alertHandlerCalls.length, 1);
    assert.strictEqual(alertHandlerCalls[0].level, "info");
    assert.strictEqual(alertHandlerCalls[0].threshold, 25);
  });

  await test("fires warn alert when crossing warn threshold", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: 60 });
    await waitForAsync();

    assert.strictEqual(alertHandlerCalls.length, 1);
    assert.strictEqual(alertHandlerCalls[0].level, "warn");
    assert.strictEqual(alertHandlerCalls[0].threshold, 50);
  });

  await test("fires critical alert when crossing critical threshold", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: 150 });
    await waitForAsync();

    assert.strictEqual(alertHandlerCalls.length, 1);
    assert.strictEqual(alertHandlerCalls[0].level, "critical");
    assert.strictEqual(alertHandlerCalls[0].threshold, 100);
  });

  await test("does not alert when below info threshold", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: 10 });
    await waitForAsync();

    assert.strictEqual(alertHandlerCalls.length, 0);
  });

  // ==========================================================================
  // LEVEL CHANGES
  // ==========================================================================

  await test("fires alert when level increases", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: 30 });
    await waitForAsync();
    assert.strictEqual(alertHandlerCalls.length, 1);

    alertSink.record({ name: "test_metric", type: "gauge", value: 60 });
    await waitForAsync();
    assert.strictEqual(alertHandlerCalls.length, 2);
    assert.strictEqual(alertHandlerCalls[1].level, "warn");
  });

  await test("fires clear alert when level decreases below threshold", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: 60 });
    await waitForAsync();
    assert.strictEqual(alertHandlerCalls.length, 1);

    alertSink.record({ name: "test_metric", type: "gauge", value: 10 });
    await waitForAsync();
    assert.strictEqual(clearHandlerCalls.length, 1);
  });

  // ==========================================================================
  // RE-ALERT PREVENTION
  // ==========================================================================

  await test("does not re-alert immediately when staying above threshold", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: 60 });
    await waitForAsync();
    assert.strictEqual(alertHandlerCalls.length, 1);

    alertSink.record({ name: "test_metric", type: "gauge", value: 70 });
    await waitForAsync();
    assert.strictEqual(alertHandlerCalls.length, 1); // Still 1, no re-alert
  });

  // ==========================================================================
  // TYPE FILTERING
  // ==========================================================================

  await test("ignores string values", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: "100" as unknown as number });
    await waitForAsync();
    assert.strictEqual(alertHandlerCalls.length, 0);
  });

  await test("ignores boolean values", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: true as unknown as number });
    await waitForAsync();
    assert.strictEqual(alertHandlerCalls.length, 0);
  });

  await test("ignores NaN values", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: NaN });
    await waitForAsync();
    assert.strictEqual(alertHandlerCalls.length, 0);
  });

  await test("ignores Infinity values", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: Infinity });
    await waitForAsync();
    assert.strictEqual(alertHandlerCalls.length, 0);
  });

  await test("ignores undefined values", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: undefined });
    await waitForAsync();
    assert.strictEqual(alertHandlerCalls.length, 0);
  });

  // ==========================================================================
  // CONFIG VALIDATION
  // ==========================================================================

  await test("throws on negative warn threshold", () => {
    assert.throws(
      () => {
        new ThresholdAlertSink({
          sink: new NoOpSink(),
          thresholds: { test: { warn: -10 } },
          onAlert: () => {},
        });
      },
      /negative warn threshold/
    );
  });

  await test("throws when critical < warn", () => {
    assert.throws(
      () => {
        new ThresholdAlertSink({
          sink: new NoOpSink(),
          thresholds: { test: { warn: 100, critical: 50 } },
          onAlert: () => {},
        });
      },
      /critical.*< warn/
    );
  });

  await test("throws when info > warn", () => {
    assert.throws(
      () => {
        new ThresholdAlertSink({
          sink: new NoOpSink(),
          thresholds: { test: { warn: 50, info: 100 } },
          onAlert: () => {},
        });
      },
      /info.*> warn/
    );
  });

  await test("accepts valid config with all thresholds", () => {
    assert.doesNotThrow(() => {
      new ThresholdAlertSink({
        sink: new NoOpSink(),
        thresholds: { test: { info: 25, warn: 50, critical: 100 } },
        onAlert: () => {},
      });
    });
  });

  // ==========================================================================
  // BOUNDED ALERT STATES
  // ==========================================================================

  await test("evicts oldest state when maxAlertStates exceeded", async () => {
    reset();
    const boundedSink = new ThresholdAlertSink({
      sink: new NoOpSink(),
      thresholds: { test_metric: { warn: 50 } },
      onAlert: (alert) => {
        alertHandlerCalls.push({
          metricName: alert.metricName,
          value: alert.value,
          level: alert.level,
          threshold: alert.threshold,
        });
      },
      maxAlertStates: 2,
    });

    boundedSink.record({ name: "test_metric", type: "gauge", value: 60, tags: { id: "1" } });
    await waitForAsync();
    boundedSink.record({ name: "test_metric", type: "gauge", value: 60, tags: { id: "2" } });
    await waitForAsync();
    boundedSink.record({ name: "test_metric", type: "gauge", value: 60, tags: { id: "3" } });
    await waitForAsync();

    const states = boundedSink.getAlertStates();
    assert.strictEqual(states.size, 2);

    // First state should have been evicted
    const keys = Array.from(states.keys());
    assert.ok(keys[0].includes("id=2"), "First key should be id=2");
    assert.ok(keys[1].includes("id=3"), "Second key should be id=3");
  });

  // ==========================================================================
  // TAG HANDLING
  // ==========================================================================

  await test("creates separate alert states for different tags", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: 60, tags: { session: "a" } });
    alertSink.record({ name: "test_metric", type: "gauge", value: 60, tags: { session: "b" } });
    await waitForAsync();

    assert.strictEqual(alertHandlerCalls.length, 2);
  });

  // ==========================================================================
  // ERROR HANDLING
  // ==========================================================================

  await test("catches and logs alert handler errors", async () => {
    reset();
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(String(args[0]));
    };

    const errorSink = new ThresholdAlertSink({
      sink: new NoOpSink(),
      thresholds: { test: { warn: 50 } },
      onAlert: () => {
        throw new Error("Handler error");
      },
    });

    errorSink.record({ name: "test", type: "gauge", value: 60 });
    await waitForAsync();

    console.error = originalError;
    assert.ok(errors.some((e) => e.includes("Alert handler failed")));
  });

  // ==========================================================================
  // RUNTIME CONFIG CHANGES
  // ==========================================================================

  await test("allows adding thresholds at runtime", async () => {
    reset();
    alertSink.setThreshold("new_metric", { warn: 10 });

    alertSink.record({ name: "new_metric", type: "gauge", value: 20 });
    await waitForAsync();

    assert.strictEqual(alertHandlerCalls.length, 1);
    assert.strictEqual(alertHandlerCalls[0].metricName, "new_metric");
  });

  await test("allows removing thresholds at runtime", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: 60 });
    await waitForAsync();
    assert.strictEqual(alertHandlerCalls.length, 1);

    alertSink.removeThreshold("test_metric");

    alertSink.record({ name: "test_metric", type: "gauge", value: 70 });
    await waitForAsync();

    // No additional alert
    assert.strictEqual(alertHandlerCalls.length, 1);
  });

  await test("clears alert state when removing threshold", async () => {
    reset();
    alertSink.record({ name: "test_metric", type: "gauge", value: 60 });
    await waitForAsync();

    const statesBefore = alertSink.getAlertStates();
    assert.strictEqual(statesBefore.size, 1);

    alertSink.removeThreshold("test_metric");

    const statesAfter = alertSink.getAlertStates();
    assert.strictEqual(statesAfter.size, 0);
  });
}

// =============================================================================
// RUN
// =============================================================================

async function main() {
  console.log("🧪 ThresholdAlertSink Tests\n");

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
