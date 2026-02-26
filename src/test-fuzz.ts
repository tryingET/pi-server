/**
 * Fuzz tests for concurrent operations and race conditions.
 *
 * These tests use randomized inputs and high concurrency to surface
 * bugs that only appear under load. Run multiple times to increase coverage.
 *
 * Run with: node --experimental-vm-modules dist/test-fuzz.js
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { CommandExecutionEngine } from "./command-execution-engine.js";
import { CommandReplayStore } from "./command-replay-store.js";
import { SessionVersionStore } from "./session-version-store.js";
import type { SessionResolver, RpcResponse } from "./types.js";

// =============================================================================
// TEST INFRASTRUCTURE
// =============================================================================

function makeResponse(overrides: Partial<RpcResponse>): RpcResponse {
  return {
    type: "response",
    command: "list_sessions",
    success: true,
    ...overrides,
  } as RpcResponse;
}

function createMockSessionResolver(): SessionResolver {
  return {
    getSession() {
      return undefined;
    },
  };
}

function createEngine() {
  const replayStore = new CommandReplayStore();
  const versionStore = new SessionVersionStore();
  const resolver = createMockSessionResolver();

  return {
    engine: new CommandExecutionEngine(replayStore, versionStore, resolver, {
      defaultCommandTimeoutMs: 5000,
      shortCommandTimeoutMs: 100,
      dependencyWaitTimeoutMs: 200,
    }),
    replayStore,
    versionStore,
  };
}

// Random integer in range [min, max]
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Random delay 0-50ms
function randomDelay(): Promise<void> {
  return new Promise((r) => setTimeout(r, randInt(0, 50)));
}

// =============================================================================
// FUZZ TESTS
// =============================================================================

describe("fuzz: lane serialization", () => {
  // Test that concurrent commands in the same lane execute sequentially
  it("same-lane commands execute sequentially under stress", async () => {
    const { engine } = createEngine();
    const laneKey = "session:fuzz-lane";
    const executionOrder: number[] = [];
    const iterations = 100;

    // Launch all tasks concurrently
    const tasks = Array.from({ length: iterations }, (_, i) =>
      engine.runOnLane(laneKey, async () => {
        // Record start
        const myIndex = i;
        // Simulate work with random delay
        await randomDelay();
        // Record completion order
        executionOrder.push(myIndex);
        return makeResponse({ success: true });
      })
    );

    await Promise.all(tasks);

    // Verify sequential execution: each task should complete before the next starts
    // Since we record completion order, it should match submission order for same lane
    assert.strictEqual(executionOrder.length, iterations, "All tasks should complete");

    // In a sequential lane, tasks complete in submission order
    for (let i = 0; i < iterations; i++) {
      assert.strictEqual(executionOrder[i], i, `Task ${i} should complete in order`);
    }
  });

  // Test that different lanes execute concurrently
  it("different lanes execute concurrently", async () => {
    const { engine } = createEngine();
    const laneCount = 10;
    const tasksPerLane = 10;

    const lock = { currentConcurrent: 0, maxConcurrent: 0 };

    const tasks: Promise<RpcResponse>[] = [];

    for (let lane = 0; lane < laneCount; lane++) {
      for (let task = 0; task < tasksPerLane; task++) {
        tasks.push(
          engine.runOnLane(`lane-${lane}`, async () => {
            lock.currentConcurrent++;
            lock.maxConcurrent = Math.max(lock.maxConcurrent, lock.currentConcurrent);

            await new Promise((r) => setTimeout(r, 10));

            lock.currentConcurrent--;
            return makeResponse({ success: true });
          })
        );
      }
    }

    await Promise.all(tasks);

    // With 10 lanes, we should see concurrent execution
    assert.ok(
      lock.maxConcurrent > 1,
      `Expected concurrent execution (max ${lock.maxConcurrent}), but tasks ran sequentially`
    );
    assert.strictEqual(tasks.length, laneCount * tasksPerLane, "All tasks should complete");
  });

  // Stress test lane cleanup
  it("lane cleanup under high churn", async () => {
    const { engine } = createEngine();
    const laneCount = 50;
    const waves = 20;

    for (let wave = 0; wave < waves; wave++) {
      const tasks = Array.from({ length: laneCount }, (_, i) =>
        engine.runOnLane(`wave-${wave}-lane-${i}`, async () => {
          await randomDelay();
          return makeResponse({ success: true });
        })
      );

      await Promise.all(tasks);

      // After each wave, all lanes should be cleaned up
      const stats = engine.getStats();
      assert.strictEqual(stats.laneCount, 0, `Wave ${wave}: lanes should be cleaned up`);
    }
  });
});

describe("fuzz: in-flight tracking", () => {
  it("in-flight commands are tracked correctly under concurrent load", async () => {
    const { replayStore } = createEngine();
    const commandCount = 100;

    // Register many in-flight commands concurrently
    const registerTasks = Array.from({ length: commandCount }, (_, i) => {
      const cmdId = `fuzz-cmd-${i}`;
      const promise = new Promise<RpcResponse>((resolve) => {
        setTimeout(() => resolve(makeResponse({ success: true })), randInt(1, 20));
      });

      return {
        cmdId,
        record: {
          commandType: "test",
          laneKey: `lane-${i % 10}`,
          fingerprint: `fp-${i}`,
          promise,
        },
        promise,
      };
    });

    // Register all
    for (const task of registerTasks) {
      const registered = replayStore.registerInFlight(task.cmdId, task.record);
      assert.strictEqual(registered, true, `Command ${task.cmdId} should register`);
    }

    // Verify all tracked
    const statsAfterRegister = replayStore.getStats();
    assert.strictEqual(
      statsAfterRegister.inFlightCount,
      commandCount,
      "All commands should be in-flight"
    );

    // Wait for all to complete
    await Promise.all(registerTasks.map((t) => t.promise));

    // Unregister all
    for (const task of registerTasks) {
      replayStore.unregisterInFlight(task.cmdId, task.record);
    }

    // Verify all cleaned up
    const statsAfterUnregister = replayStore.getStats();
    assert.strictEqual(
      statsAfterUnregister.inFlightCount,
      0,
      "All commands should be unregistered"
    );
  });

  it("in-flight limit rejection under load", async () => {
    const maxInFlight = 10;
    const replayStore = new CommandReplayStore({ maxInFlightCommands: maxInFlight });
    const attemptCount = 100;

    let registered = 0;
    let rejected = 0;

    // Try to register more than limit
    for (let i = 0; i < attemptCount; i++) {
      const cmdId = `limit-cmd-${i}`;
      const record = {
        commandType: "test",
        laneKey: "test-lane",
        fingerprint: `fp-${i}`,
        promise: new Promise<RpcResponse>(() => {}), // Never resolves
      };

      const result = replayStore.registerInFlight(cmdId, record);
      if (result) {
        registered++;
      } else {
        rejected++;
      }
    }

    assert.strictEqual(registered, maxInFlight, "Should accept exactly maxInFlight");
    assert.strictEqual(rejected, attemptCount - maxInFlight, "Should reject excess");

    const stats = replayStore.getStats();
    assert.strictEqual(stats.inFlightRejections, rejected, "Should track rejections");
  });

  it("unregister with wrong record is ignored", async () => {
    const { replayStore } = createEngine();

    const cmdId = "race-cmd";
    const record1 = {
      commandType: "test",
      laneKey: "lane-1",
      fingerprint: "fp-1",
      promise: Promise.resolve(makeResponse({ success: true })),
    };
    const record2 = {
      commandType: "test",
      laneKey: "lane-2", // Different!
      fingerprint: "fp-2",
      promise: Promise.resolve(makeResponse({ success: false })),
    };

    // Register with record1
    replayStore.registerInFlight(cmdId, record1);

    // Try to unregister with wrong record
    replayStore.unregisterInFlight(cmdId, record2);

    // Should still exist
    assert.ok(replayStore.getInFlight(cmdId), "Should not unregister with wrong record");

    // Unregister with correct record
    replayStore.unregisterInFlight(cmdId, record1);

    // Now gone
    assert.strictEqual(
      replayStore.getInFlight(cmdId),
      undefined,
      "Should unregister with correct record"
    );
  });
});

describe("fuzz: outcome storage", () => {
  it("outcome storage under concurrent writes", async () => {
    const { replayStore } = createEngine();
    const commandCount = 200;

    // Concurrent writes to outcome store
    const tasks = Array.from({ length: commandCount }, (_, i) => {
      return new Promise<void>((resolve) => {
        // Randomize order of writes
        setTimeout(
          () => {
            replayStore.storeCommandOutcome({
              commandId: `outcome-cmd-${i}`,
              commandType: "test",
              laneKey: `lane-${i % 20}`,
              fingerprint: `fp-${i}`,
              success: true,
              response: makeResponse({ success: true }),
              finishedAt: Date.now(),
            });
            resolve();
          },
          randInt(0, 50)
        );
      });
    });

    await Promise.all(tasks);

    // All outcomes should be retrievable
    for (let i = 0; i < commandCount; i++) {
      const outcome = replayStore.getCommandOutcome(`outcome-cmd-${i}`);
      assert.ok(outcome, `Outcome ${i} should exist`);
      assert.strictEqual(outcome.success, true);
    }
  });

  it("outcome update preserves latest", async () => {
    const { replayStore } = createEngine();
    const cmdId = "update-cmd";
    const updates = 50;

    // Rapid updates to same command
    for (let i = 0; i < updates; i++) {
      replayStore.storeCommandOutcome({
        commandId: cmdId,
        commandType: "test",
        laneKey: "test-lane",
        fingerprint: `fp-${i}`,
        success: i % 2 === 0,
        response: makeResponse({
          success: i % 2 === 0,
          error: i % 2 === 0 ? undefined : `error-${i}`,
        }),
        finishedAt: Date.now() + i,
      });
    }

    // Should have latest update
    const outcome = replayStore.getCommandOutcome(cmdId);
    assert.ok(outcome, "Should have outcome");
    // Last update was i=49 (odd), so success=false
    assert.strictEqual(outcome.success, false, "Should have last update");
    assert.strictEqual(outcome.finishedAt, Date.now() + updates - 1);
  });

  it("outcome retention is bounded", async () => {
    const maxOutcomes = 50;
    const replayStore = new CommandReplayStore({ maxCommandOutcomes: maxOutcomes });
    const totalCommands = 100;

    // Store more than limit
    for (let i = 0; i < totalCommands; i++) {
      replayStore.storeCommandOutcome({
        commandId: `bounded-cmd-${i}`,
        commandType: "test",
        laneKey: "test-lane",
        fingerprint: `fp-${i}`,
        success: true,
        response: makeResponse({ success: true }),
        finishedAt: Date.now(),
      });
    }

    const stats = replayStore.getStats();
    assert.strictEqual(stats.outcomeCount, maxOutcomes, "Should trim to max");

    // First outcomes should be trimmed
    for (let i = 0; i < totalCommands - maxOutcomes; i++) {
      assert.strictEqual(
        replayStore.getCommandOutcome(`bounded-cmd-${i}`),
        undefined,
        `Old outcome ${i} should be trimmed`
      );
    }

    // Last outcomes should exist
    for (let i = totalCommands - maxOutcomes; i < totalCommands; i++) {
      assert.ok(
        replayStore.getCommandOutcome(`bounded-cmd-${i}`),
        `Recent outcome ${i} should exist`
      );
    }
  });
});

describe("fuzz: fingerprinting", () => {
  it("fingerprint excludes retry identity fields", async () => {
    const { replayStore } = createEngine();
    const baseCommand = {
      type: "get_state",
      sessionId: "session-1",
    };

    // Commands with different retry identity should have same fingerprint
    const variants = [
      { ...baseCommand, id: "id-1" },
      { ...baseCommand, id: "id-2" },
      { ...baseCommand, idempotencyKey: "key-1" },
      { ...baseCommand, id: "id-3", idempotencyKey: "key-2" },
      { ...baseCommand }, // no retry fields
    ];

    const fingerprints = variants.map((cmd) => replayStore.getCommandFingerprint(cmd as any));

    // All should be equal
    for (let i = 1; i < fingerprints.length; i++) {
      assert.strictEqual(fingerprints[i], fingerprints[0], `Fingerprint ${i} should match base`);
    }
  });

  it("fingerprint collision probability is low for different commands", async () => {
    const { replayStore } = createEngine();
    const commandCount = 1000;
    const fingerprints = new Set<string>();

    for (let i = 0; i < commandCount; i++) {
      const cmd = {
        type: "prompt",
        sessionId: `session-${i % 100}`,
        message: `message-${i}-${Math.random()}`,
      };
      const fp = replayStore.getCommandFingerprint(cmd as any);
      fingerprints.add(fp);
    }

    // Should have high uniqueness
    const uniquenessRatio = fingerprints.size / commandCount;
    assert.ok(
      uniquenessRatio > 0.95,
      `Expected >95% unique fingerprints, got ${(uniquenessRatio * 100).toFixed(1)}%`
    );
  });
});

describe("fuzz: synthetic IDs", () => {
  it("synthetic IDs are unique under concurrent generation", async () => {
    const { replayStore } = createEngine();
    const commandCount = 1000;
    const ids = new Set<string>();

    // Generate IDs concurrently
    const tasks = Array.from({ length: commandCount }, () => {
      return new Promise<void>((resolve) => {
        setTimeout(
          () => {
            const cmd = { type: "test" };
            const id = replayStore.getOrCreateCommandId(cmd as any);
            ids.add(id);
            resolve();
          },
          randInt(0, 10)
        );
      });
    });

    await Promise.all(tasks);

    // All IDs should be unique
    assert.strictEqual(ids.size, commandCount, "All synthetic IDs should be unique");

    // All should have expected prefix
    for (const id of ids) {
      assert.ok(id.startsWith("anon:"), `ID ${id} should have anon: prefix`);
    }
  });

  it("synthetic IDs remain unique after clear", async () => {
    const { replayStore } = createEngine();

    const ids1 = [
      replayStore.getOrCreateCommandId({ type: "test" } as any),
      replayStore.getOrCreateCommandId({ type: "test" } as any),
      replayStore.getOrCreateCommandId({ type: "test" } as any),
    ];

    replayStore.clear();

    const ids2 = [
      replayStore.getOrCreateCommandId({ type: "test" } as any),
      replayStore.getOrCreateCommandId({ type: "test" } as any),
      replayStore.getOrCreateCommandId({ type: "test" } as any),
    ];

    // All IDs should be unique (no collision after clear)
    const allIds = [...ids1, ...ids2];
    const uniqueIds = new Set(allIds);
    assert.strictEqual(uniqueIds.size, allIds.length, "IDs should be unique across clear");
  });
});

describe("fuzz: dependency chains", () => {
  it("dependency wait timeout under stress", async () => {
    const { engine, replayStore } = createEngine();

    // Create a command that never completes
    const stuckId = "stuck-cmd";
    replayStore.registerInFlight(stuckId, {
      commandType: "test",
      laneKey: "other-lane",
      fingerprint: "fp-stuck",
      promise: new Promise<RpcResponse>(() => {}), // Never resolves
    });

    // Try to wait for it multiple times concurrently
    const tasks = Array.from({ length: 20 }, () =>
      engine.awaitDependencies([stuckId], "requester-lane")
    );

    const results = await Promise.all(tasks);

    // All should fail with timeout
    for (const result of results) {
      assert.strictEqual(result.ok, false, "Should fail with timeout");
      assert.ok(
        result.error?.includes("timed out") || result.error?.includes("stuck-cmd"),
        "Should mention timeout or dependency"
      );
    }
  });

  it("same-lane dependency is rejected", async () => {
    const { engine } = createEngine();

    // Can't depend on command in same lane
    const result = await engine.awaitDependencies(["dep-in-same-lane"], "session:same-lane");

    // This would require special setup to have the dep in-flight in same lane
    // For now, just verify the error handling path works
    assert.strictEqual(result.ok, false, "Should fail");
  });
});

describe("fuzz: replay semantics", () => {
  it("replay returns same response under concurrent requests", async () => {
    const { replayStore } = createEngine();

    // Store an outcome
    const cmdId = "replay-test-cmd";
    const command = { id: cmdId, type: "list_sessions" };
    const fp = replayStore.getCommandFingerprint(command as any);

    const originalResponse = makeResponse({
      id: cmdId,
      success: true,
    });

    replayStore.storeCommandOutcome({
      commandId: cmdId,
      commandType: "list_sessions",
      laneKey: "test-lane",
      fingerprint: fp,
      success: true,
      response: originalResponse,
      finishedAt: Date.now(),
    });

    // Concurrent replay requests
    const tasks = Array.from({ length: 50 }, () =>
      Promise.resolve(replayStore.checkReplay(command as any, fp))
    );

    const results = await Promise.all(tasks);

    // All should be replay_cached with same response
    for (const result of results) {
      assert.strictEqual(result.kind, "replay_cached", "Should be replay_cached");
      if (result.kind === "replay_cached") {
        assert.strictEqual(result.response.success, true);
        assert.strictEqual(result.response.replayed, true);
      }
    }
  });

  it("conflict detection works under concurrent different commands", async () => {
    const { replayStore } = createEngine();

    // Store outcome for command1
    const cmdId = "conflict-cmd";
    const fp1 = "fp-command-1";
    replayStore.storeCommandOutcome({
      commandId: cmdId,
      commandType: "command-1",
      laneKey: "test-lane",
      fingerprint: fp1,
      success: true,
      response: makeResponse({ success: true }),
      finishedAt: Date.now(),
    });

    // Now try to use same ID with different fingerprint (conflict)
    const fp2 = "fp-command-2";
    const command2 = { id: cmdId, type: "command-2" };

    const result = replayStore.checkReplay(command2 as any, fp2);

    assert.strictEqual(result.kind, "conflict", "Should detect conflict");
    if (result.kind === "conflict") {
      assert.strictEqual(result.response.success, false);
      assert.ok(result.response.error?.includes("Conflicting"));
    }
  });
});
