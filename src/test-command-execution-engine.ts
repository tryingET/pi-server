/**
 * Unit tests for command-execution-engine.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { CommandExecutionEngine, withTimeout } from "./command-execution-engine.js";
import { CommandReplayStore } from "./command-replay-store.js";
import { SessionVersionStore } from "./session-version-store.js";
import type { SessionResolver, RpcResponse } from "./types.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

// Helper to create minimal responses
function makeResponse(overrides: Partial<RpcResponse>): RpcResponse {
  return {
    type: "response",
    command: "test",
    success: true,
    ...overrides,
  } as RpcResponse;
}

// Mock SessionResolver
function createMockSessionResolver(sessions: Map<string, Partial<AgentSession>>): SessionResolver {
  return {
    getSession(sessionId: string) {
      return sessions.get(sessionId) as AgentSession | undefined;
    },
  };
}

// Create engine with default config
function createEngine(
  sessions: Map<string, Partial<AgentSession>> = new Map(),
  options: {
    abortHandlers?: Partial<Record<string, (session: AgentSession) => void | Promise<void>>>;
  } = {}
) {
  const replayStore = new CommandReplayStore();
  const versionStore = new SessionVersionStore();
  const resolver = createMockSessionResolver(sessions);

  return {
    engine: new CommandExecutionEngine(replayStore, versionStore, resolver, {
      defaultCommandTimeoutMs: 5000,
      shortCommandTimeoutMs: 100,
      dependencyWaitTimeoutMs: 200,
      abortHandlers: options.abortHandlers,
    }),
    replayStore,
    versionStore,
  };
}

describe("command-execution-engine", () => {
  // ==========================================================================
  // withTimeout HELPER
  // ==========================================================================

  describe("withTimeout", () => {
    it("resolves before timeout", async () => {
      const promise = Promise.resolve("result");
      const result = await withTimeout(promise, 100, "test");
      assert.strictEqual(result, "result");
    });

    it("rejects on timeout", async () => {
      const promise = new Promise((resolve) => setTimeout(resolve, 1000));
      await assert.rejects(
        withTimeout(promise, 10, "test-command"),
        /Command 'test-command' timed out after 10ms/
      );
    });

    it("calls onTimeout when timeout occurs", async () => {
      let called = false;
      const promise = new Promise((resolve) => setTimeout(resolve, 1000));
      await assert.rejects(
        withTimeout(promise, 10, "test", () => {
          called = true;
        }),
        /timed out/
      );
      assert.strictEqual(called, true);
    });

    it("ignores onTimeout errors", async () => {
      const promise = new Promise((resolve) => setTimeout(resolve, 1000));
      // Should not throw from onTimeout, only from timeout
      await assert.rejects(
        withTimeout(promise, 10, "test", async () => {
          throw new Error("onTimeout error");
        }),
        /timed out/
      );
    });

    it("propagates promise rejection", async () => {
      const promise = Promise.reject(new Error("promise error"));
      await assert.rejects(withTimeout(promise, 1000, "test"), /promise error/);
    });

    it("does not resolve after timeout", async () => {
      let resolvePromise: (value: string) => void;
      const promise = new Promise<string>((resolve) => {
        resolvePromise = resolve;
      });

      const timeoutPromise = withTimeout(promise, 10, "test");

      // Wait for timeout
      await assert.rejects(timeoutPromise, /timed out/);

      // Now resolve the promise - should not affect anything
      resolvePromise!("late result");
    });
  });

  // ==========================================================================
  // LANE SERIALIZATION
  // ==========================================================================

  describe("getLaneKey", () => {
    it("returns session lane for session commands", () => {
      const { engine } = createEngine();
      assert.strictEqual(
        engine.getLaneKey({ type: "get_state", sessionId: "s1" } as any),
        "session:s1"
      );
    });

    it("returns server lane for server commands", () => {
      const { engine } = createEngine();
      assert.strictEqual(engine.getLaneKey({ type: "list_sessions" } as any), "server");
    });
  });

  describe("runOnLane", () => {
    it("executes task in lane", async () => {
      const { engine } = createEngine();
      const result = await engine.runOnLane("test-lane", async () => "result");
      assert.strictEqual(result, "result");
    });

    it("serializes tasks in same lane", async () => {
      const { engine } = createEngine();
      const order: string[] = [];

      const task1 = engine.runOnLane("lane-1", async () => {
        order.push("1-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("1-end");
      });

      const task2 = engine.runOnLane("lane-1", async () => {
        order.push("2-start");
        await new Promise((r) => setTimeout(r, 5));
        order.push("2-end");
      });

      await Promise.all([task1, task2]);

      // Task 2 should wait for task 1
      assert.deepStrictEqual(order, ["1-start", "1-end", "2-start", "2-end"]);
    });

    it("runs tasks in different lanes concurrently", async () => {
      const { engine } = createEngine();
      const order: string[] = [];

      const task1 = engine.runOnLane("lane-1", async () => {
        order.push("1-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("1-end");
      });

      const task2 = engine.runOnLane("lane-2", async () => {
        order.push("2-start");
        await new Promise((r) => setTimeout(r, 5));
        order.push("2-end");
      });

      await Promise.all([task1, task2]);

      // Task 2 should complete before task 1 (concurrent)
      assert.strictEqual(order[0], "1-start");
      assert.strictEqual(order[1], "2-start");
      assert.strictEqual(order[2], "2-end");
      assert.strictEqual(order[3], "1-end");
    });

    it("continues lane after task failure", async () => {
      const { engine } = createEngine();

      // First task fails
      await assert.rejects(
        engine.runOnLane("lane-1", async () => {
          throw new Error("task 1 failed");
        })
      );

      // Second task should still run
      const result = await engine.runOnLane("lane-1", async () => "task 2 success");
      assert.strictEqual(result, "task 2 success");
    });

    it("propagates task errors", async () => {
      const { engine } = createEngine();
      await assert.rejects(
        engine.runOnLane("lane-1", async () => {
          throw new Error("task error");
        }),
        /task error/
      );
    });
  });

  // ==========================================================================
  // DEPENDENCY RESOLUTION
  // ==========================================================================

  describe("awaitDependencies", () => {
    it("returns ok for empty dependencies", async () => {
      const { engine } = createEngine();
      const result = await engine.awaitDependencies([], "session:s1");
      assert.deepStrictEqual(result, { ok: true });
    });

    it("returns error for empty dependency ID", async () => {
      const { engine } = createEngine();
      const result = await engine.awaitDependencies([""], "session:s1");
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.includes("non-empty"));
      }
    });

    it("returns error for unknown dependency", async () => {
      const { engine } = createEngine();
      const result = await engine.awaitDependencies(["unknown-id"], "session:s1");
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.includes("unknown"));
      }
    });

    it("returns error for failed dependency", async () => {
      const { engine, replayStore } = createEngine();

      replayStore.storeCommandOutcome({
        commandId: "failed-cmd",
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        success: false,
        error: "command failed",
        response: makeResponse({ command: "prompt", success: false, error: "command failed" }),
        finishedAt: Date.now(),
      });

      const result = await engine.awaitDependencies(["failed-cmd"], "session:s1");
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.includes("failed"));
      }
    });

    it("returns ok for successful completed dependency", async () => {
      const { engine, replayStore } = createEngine();

      replayStore.storeCommandOutcome({
        commandId: "success-cmd",
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        success: true,
        response: makeResponse({ command: "prompt", success: true }),
        finishedAt: Date.now(),
      });

      const result = await engine.awaitDependencies(["success-cmd"], "session:s1");
      assert.strictEqual(result.ok, true);
    });

    it("returns error for same-lane dependency", async () => {
      const { engine, replayStore } = createEngine();

      replayStore.registerInFlight("inflight-cmd", {
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        promise: new Promise(() => {}), // Never resolves
      });

      const result = await engine.awaitDependencies(["inflight-cmd"], "session:s1");
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.includes("same lane"));
      }
    });

    it("waits for in-flight dependency in different lane", async () => {
      const { engine, replayStore } = createEngine();

      let resolvePromise: (value: RpcResponse) => void;
      const promise = new Promise<RpcResponse>((resolve) => {
        resolvePromise = resolve;
      });

      replayStore.registerInFlight("inflight-cmd", {
        commandType: "prompt",
        laneKey: "session:s2", // Different lane
        fingerprint: "fp1",
        promise,
      });

      // Start waiting
      const waitPromise = engine.awaitDependencies(["inflight-cmd"], "session:s1");

      // Resolve after a delay
      setTimeout(() => {
        resolvePromise!(makeResponse({ command: "prompt", success: true }));
      }, 10);

      const result = await waitPromise;
      assert.strictEqual(result.ok, true);
    });

    it("returns error if in-flight dependency fails", async () => {
      const { engine, replayStore } = createEngine();

      replayStore.registerInFlight("inflight-cmd", {
        commandType: "prompt",
        laneKey: "session:s2", // Different lane
        fingerprint: "fp1",
        promise: Promise.resolve(
          makeResponse({ command: "prompt", success: false, error: "failed" })
        ),
      });

      const result = await engine.awaitDependencies(["inflight-cmd"], "session:s1");
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.includes("failed"));
      }
    });

    it("times out waiting for in-flight dependency", async () => {
      const { engine, replayStore } = createEngine();

      replayStore.registerInFlight("inflight-cmd", {
        commandType: "prompt",
        laneKey: "session:s2",
        fingerprint: "fp1",
        promise: new Promise(() => {}), // Never resolves
      });

      const result = await engine.awaitDependencies(["inflight-cmd"], "session:s1");
      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.includes("timed out"));
      }
    });

    it("handles multiple dependencies", async () => {
      const { engine, replayStore } = createEngine();

      replayStore.storeCommandOutcome({
        commandId: "dep-1",
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        success: true,
        response: makeResponse({ command: "prompt", success: true }),
        finishedAt: Date.now(),
      });

      replayStore.storeCommandOutcome({
        commandId: "dep-2",
        commandType: "get_state",
        laneKey: "session:s1",
        fingerprint: "fp2",
        success: true,
        response: makeResponse({ command: "get_state", success: true }),
        finishedAt: Date.now(),
      });

      const result = await engine.awaitDependencies(["dep-1", "dep-2"], "session:s1");
      assert.strictEqual(result.ok, true);
    });
  });

  // ==========================================================================
  // TIMEOUT MANAGEMENT
  // ==========================================================================

  describe("getCommandTimeoutMs", () => {
    it("returns null for no-timeout commands", () => {
      const { engine } = createEngine();
      assert.strictEqual(engine.getCommandTimeoutMs("create_session"), null);
    });

    it("returns short timeout for short-timeout commands", () => {
      const { engine } = createEngine();
      assert.strictEqual(engine.getCommandTimeoutMs("get_state"), 100);
    });

    it("returns default timeout for other commands", () => {
      const { engine } = createEngine();
      assert.strictEqual(engine.getCommandTimeoutMs("prompt"), 5000);
    });
  });

  describe("abortTimedOutCommand", () => {
    it("does nothing for command without sessionId", async () => {
      const { engine } = createEngine();
      // Should not throw
      await engine.abortTimedOutCommand({ type: "list_sessions" } as any);
    });

    it("does nothing for unknown session", async () => {
      const { engine } = createEngine();
      // Should not throw
      await engine.abortTimedOutCommand({ type: "prompt", sessionId: "unknown" } as any);
    });

    it("does nothing for command without abort handler", async () => {
      createEngine();
      const sessions = new Map<string, Partial<AgentSession>>();
      sessions.set("s1", {} as AgentSession);
      const { engine: engineWithSession } = createEngine(sessions);

      // get_state has no abort handler
      await engineWithSession.abortTimedOutCommand({ type: "get_state", sessionId: "s1" } as any);
    });

    it("calls abort handler for prompt", async () => {
      let aborted = false;
      const sessions = new Map<string, Partial<AgentSession>>();
      sessions.set("s1", {
        abort: () => {
          aborted = true;
        },
      } as Partial<AgentSession>);
      const { engine } = createEngine(sessions);

      await engine.abortTimedOutCommand({ type: "prompt", sessionId: "s1" } as any);
      assert.strictEqual(aborted, true);
    });

    it("handles abort handler errors", async () => {
      const sessions = new Map<string, Partial<AgentSession>>();
      sessions.set("s1", {
        abort: () => {
          throw new Error("abort failed");
        },
      } as Partial<AgentSession>);
      const { engine } = createEngine(sessions);

      // Should not throw
      await engine.abortTimedOutCommand({ type: "prompt", sessionId: "s1" } as any);
    });

    it("uses custom abort handler when provided", async () => {
      let customAbortCalled = false;
      let defaultAbortCalled = false;

      const sessions = new Map<string, Partial<AgentSession>>();
      sessions.set("s1", {
        abort: () => {
          defaultAbortCalled = true;
        },
      } as Partial<AgentSession>);

      const { engine } = createEngine(sessions, {
        abortHandlers: {
          // Override prompt with custom handler
          prompt: () => {
            customAbortCalled = true;
          },
        },
      });

      await engine.abortTimedOutCommand({ type: "prompt", sessionId: "s1" } as any);

      // Custom handler should be called, not the default
      assert.strictEqual(customAbortCalled, true);
      assert.strictEqual(defaultAbortCalled, false);
    });

    it("falls back to default handler for unregistered commands", async () => {
      let defaultAbortCalled = false;

      const sessions = new Map<string, Partial<AgentSession>>();
      sessions.set("s1", {
        abort: () => {
          defaultAbortCalled = true;
        },
      } as Partial<AgentSession>);

      // Register custom handler only for steer, not prompt
      const { engine } = createEngine(sessions, {
        abortHandlers: {
          steer: () => {},
        },
      });

      await engine.abortTimedOutCommand({ type: "prompt", sessionId: "s1" } as any);

      // Default prompt handler should still work
      assert.strictEqual(defaultAbortCalled, true);
    });
  });

  describe("executeWithTimeout", () => {
    it("returns result for fast command", async () => {
      const { engine } = createEngine();
      const promise = Promise.resolve(makeResponse({ command: "prompt", success: true }));

      const result = await engine.executeWithTimeout("prompt", promise, {
        type: "prompt",
        sessionId: "s1",
      } as any);

      assert.strictEqual(result.success, true);
    });

    it("times out slow command", async () => {
      const { engine } = createEngine();
      const promise = new Promise<RpcResponse>(() => {}); // Never resolves

      await assert.rejects(
        engine.executeWithTimeout("get_state", promise, {
          type: "get_state",
          sessionId: "s1",
        } as any),
        /timed out/
      );
    });

    it("does not time out no-timeout commands", async () => {
      const { engine } = createEngine();
      let resolvePromise: (value: RpcResponse) => void;
      const promise = new Promise<RpcResponse>((resolve) => {
        resolvePromise = resolve;
      });

      // Start execution (should not timeout quickly)
      const execPromise = engine.executeWithTimeout("create_session", promise, {
        type: "create_session",
      } as any);

      // Resolve after what would be a timeout for other commands
      setTimeout(() => {
        resolvePromise!(makeResponse({ command: "create_session", success: true }));
      }, 50);

      const result = await execPromise;
      assert.strictEqual(result.success, true);
    });
  });

  // ==========================================================================
  // VERSION CHECKS
  // ==========================================================================

  describe("checkSessionVersion", () => {
    it("returns error for unknown session", () => {
      const { engine } = createEngine();
      const result = engine.checkSessionVersion("unknown", 0, "prompt");
      assert.ok(result);
      assert.strictEqual(result?.success, false);
      assert.ok(result?.error.includes("not found"));
    });

    it("returns error for version mismatch", () => {
      const { engine, versionStore } = createEngine();
      versionStore.initialize("s1");
      versionStore.increment("s1"); // Now at version 1

      const result = engine.checkSessionVersion("s1", 0, "prompt");
      assert.ok(result);
      assert.strictEqual(result?.success, false);
      assert.ok(result?.error.includes("mismatch"));
    });

    it("returns undefined for matching version", () => {
      const { engine, versionStore } = createEngine();
      versionStore.initialize("s1");

      const result = engine.checkSessionVersion("s1", 0, "prompt");
      assert.strictEqual(result, undefined);
    });

    it("preserves command type in error", () => {
      const { engine } = createEngine();
      const result = engine.checkSessionVersion("unknown", 0, "custom_command");
      assert.strictEqual(result?.command, "custom_command");
    });
  });

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  describe("clear", () => {
    it("clears lane state", async () => {
      const { engine } = createEngine();

      // Start a task
      const task = engine.runOnLane("lane-1", async () => {
        await new Promise((r) => setTimeout(r, 100));
        return "result";
      });

      // Clear while task is running
      engine.clear();

      // Task should still complete (clear doesn't cancel)
      const result = await task;
      assert.strictEqual(result, "result");
    });
  });

  // ==========================================================================
  // STATS
  // ==========================================================================

  describe("getStats", () => {
    it("returns zero lanes for new engine", () => {
      const { engine } = createEngine();
      const stats = engine.getStats();
      assert.strictEqual(stats.laneCount, 0);
    });

    it("tracks lanes during concurrent execution", async () => {
      const { engine } = createEngine();

      // Start multiple concurrent tasks on different lanes
      const tasks = [
        engine.runOnLane("lane-1", async () => {
          await new Promise((r) => setTimeout(r, 50));
          return "result-1";
        }),
        engine.runOnLane("lane-2", async () => {
          await new Promise((r) => setTimeout(r, 50));
          return "result-2";
        }),
      ];

      // Check while tasks are running (before they complete)
      const statsDuring = engine.getStats();
      assert.ok(
        statsDuring.laneCount >= 2,
        `Expected at least 2 lanes, got ${statsDuring.laneCount}`
      );

      await Promise.all(tasks);

      // After all completions, lanes are cleaned up
      const statsAfter = engine.getStats();
      assert.strictEqual(statsAfter.laneCount, 0);
    });
  });
});
