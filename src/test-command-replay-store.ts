/**
 * Unit tests for command-replay-store.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { CommandReplayStore } from "./command-replay-store.js";
import type { RpcCommand, RpcResponse } from "./types.js";

// Helper to create minimal commands
function makeCommand(overrides: Partial<RpcCommand> & { type: string }): RpcCommand {
  return overrides as RpcCommand;
}

// Helper to create minimal responses
function makeResponse(overrides: Partial<RpcResponse>): RpcResponse {
  return {
    type: "response",
    command: "test",
    success: true,
    ...overrides,
  } as RpcResponse;
}

describe("command-replay-store", () => {
  // ==========================================================================
  // COMMAND ID GENERATION
  // ==========================================================================

  describe("getOrCreateCommandId", () => {
    it("returns explicit ID if provided", () => {
      const store = new CommandReplayStore();
      const command = makeCommand({ id: "explicit-id", type: "get_state" });
      assert.strictEqual(store.getOrCreateCommandId(command), "explicit-id");
    });

    it("generates synthetic ID if no explicit ID", () => {
      const store = new CommandReplayStore();
      const command = makeCommand({ type: "get_state" });
      const id = store.getOrCreateCommandId(command);
      assert.ok(id.startsWith("anon:"));
    });

    it("generates unique synthetic IDs", () => {
      const store = new CommandReplayStore();
      const command1 = makeCommand({ type: "get_state" });
      const command2 = makeCommand({ type: "get_state" });
      const id1 = store.getOrCreateCommandId(command1);
      const id2 = store.getOrCreateCommandId(command2);
      assert.notStrictEqual(id1, id2);
    });

    it("increments sequence for each synthetic ID", () => {
      const store = new CommandReplayStore();
      const ids = [
        store.getOrCreateCommandId(makeCommand({ type: "get_state" })),
        store.getOrCreateCommandId(makeCommand({ type: "get_state" })),
        store.getOrCreateCommandId(makeCommand({ type: "get_state" })),
      ];
      // Extract sequence numbers (format: anon:timestamp:sequence)
      const seqs = ids.map((id) => parseInt(id.split(":")[2], 10));
      assert.strictEqual(seqs[1], seqs[0] + 1);
      assert.strictEqual(seqs[2], seqs[1] + 1);
    });
  });

  // ==========================================================================
  // FINGERPRINTING
  // ==========================================================================

  describe("getCommandFingerprint", () => {
    it("excludes ID from fingerprint", () => {
      const store = new CommandReplayStore();
      const cmd1 = makeCommand({ id: "id1", type: "get_state", sessionId: "s1" });
      const cmd2 = makeCommand({ id: "id2", type: "get_state", sessionId: "s1" });
      assert.strictEqual(store.getCommandFingerprint(cmd1), store.getCommandFingerprint(cmd2));
    });

    it("includes type in fingerprint", () => {
      const store = new CommandReplayStore();
      const cmd1 = makeCommand({ type: "get_state", sessionId: "s1" });
      const cmd2 = makeCommand({ type: "get_messages", sessionId: "s1" });
      assert.notStrictEqual(store.getCommandFingerprint(cmd1), store.getCommandFingerprint(cmd2));
    });

    it("includes other fields in fingerprint", () => {
      const store = new CommandReplayStore();
      const cmd1 = makeCommand({ type: "get_state", sessionId: "s1" });
      const cmd2 = makeCommand({ type: "get_state", sessionId: "s2" });
      assert.notStrictEqual(store.getCommandFingerprint(cmd1), store.getCommandFingerprint(cmd2));
    });

    it("excludes idempotencyKey from fingerprint", () => {
      const store = new CommandReplayStore();
      const cmd1 = makeCommand({ type: "get_state", sessionId: "s1" });
      const cmd2 = makeCommand({ type: "get_state", sessionId: "s1", idempotencyKey: "key1" });
      // Same semantic command, different retry identity
      assert.strictEqual(store.getCommandFingerprint(cmd1), store.getCommandFingerprint(cmd2));
    });

    it("excludes both id and idempotencyKey from fingerprint", () => {
      const store = new CommandReplayStore();
      const cmd1 = makeCommand({ id: "id1", type: "get_state", sessionId: "s1" });
      const cmd2 = makeCommand({
        id: "id2",
        type: "get_state",
        sessionId: "s1",
        idempotencyKey: "key1",
      });
      // Same semantic command, completely different retry identity
      assert.strictEqual(store.getCommandFingerprint(cmd1), store.getCommandFingerprint(cmd2));
    });
  });

  // ==========================================================================
  // IDEMPOTENCY KEY CACHE
  // ==========================================================================

  describe("cleanupIdempotencyCache", () => {
    it("removes expired entries", async () => {
      const store = new CommandReplayStore({ idempotencyTtlMs: 10 });
      const command = makeCommand({ type: "get_state", sessionId: "s1", idempotencyKey: "key1" });
      const fingerprint = store.getCommandFingerprint(command);

      store.cacheIdempotencyResult({
        command,
        idempotencyKey: "key1",
        commandType: "get_state",
        fingerprint,
        response: makeResponse({ command: "get_state", success: true }),
      });

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 20));

      store.cleanupIdempotencyCache();

      const result = store.checkReplay(command, fingerprint);
      assert.strictEqual(result.kind, "proceed");
    });

    it("keeps non-expired entries", () => {
      const store = new CommandReplayStore({ idempotencyTtlMs: 60000 });
      const command = makeCommand({ type: "get_state", sessionId: "s1", idempotencyKey: "key1" });
      const fingerprint = store.getCommandFingerprint(command);

      store.cacheIdempotencyResult({
        command,
        idempotencyKey: "key1",
        commandType: "get_state",
        fingerprint,
        response: makeResponse({ command: "get_state", success: true }),
      });

      store.cleanupIdempotencyCache();

      const result = store.checkReplay(command, fingerprint);
      assert.strictEqual(result.kind, "replay_cached");
    });
  });

  describe("cacheIdempotencyResult", () => {
    it("stores result for idempotency key", () => {
      const store = new CommandReplayStore();
      const command = makeCommand({ type: "get_state", sessionId: "s1", idempotencyKey: "key1" });
      const fingerprint = store.getCommandFingerprint(command);

      store.cacheIdempotencyResult({
        command,
        idempotencyKey: "key1",
        commandType: "get_state",
        fingerprint,
        response: makeResponse({
          command: "get_state",
          success: true,
          data: { foo: "bar" } as any,
        }),
      });

      const result = store.checkReplay(command, fingerprint);
      assert.strictEqual(result.kind, "replay_cached");
      if (result.kind === "replay_cached") {
        assert.strictEqual(result.response.success, true);
        assert.deepStrictEqual((result.response as any).data, { foo: "bar" });
      }
    });
  });

  // ==========================================================================
  // COMMAND OUTCOMES
  // ==========================================================================

  describe("storeCommandOutcome", () => {
    it("stores outcome by command ID", () => {
      const store = new CommandReplayStore();
      store.storeCommandOutcome({
        commandId: "cmd-1",
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        success: true,
        response: makeResponse({ command: "prompt", success: true }),
        finishedAt: Date.now(),
      });

      const outcome = store.getCommandOutcome("cmd-1");
      assert.ok(outcome);
      assert.strictEqual(outcome?.commandId, "cmd-1");
      assert.strictEqual(outcome?.commandType, "prompt");
      assert.strictEqual(outcome?.success, true);
    });

    it("updates existing outcome", () => {
      const store = new CommandReplayStore();
      store.storeCommandOutcome({
        commandId: "cmd-1",
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        success: true,
        response: makeResponse({ command: "prompt", success: true }),
        finishedAt: 1000,
      });

      store.storeCommandOutcome({
        commandId: "cmd-1",
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp2",
        success: false,
        error: "failed",
        response: makeResponse({ command: "prompt", success: false, error: "failed" }),
        finishedAt: 2000,
      });

      const outcome = store.getCommandOutcome("cmd-1");
      assert.strictEqual(outcome?.success, false);
      assert.strictEqual(outcome?.finishedAt, 2000);
    });
  });

  describe("getCommandOutcome", () => {
    it("returns undefined for unknown command ID", () => {
      const store = new CommandReplayStore();
      assert.strictEqual(store.getCommandOutcome("unknown"), undefined);
    });
  });

  // ==========================================================================
  // IN-FLIGHT TRACKING
  // ==========================================================================

  describe("registerInFlight", () => {
    it("registers in-flight command", () => {
      const store = new CommandReplayStore();
      const record = {
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        promise: Promise.resolve(makeResponse({ command: "prompt", success: true })),
      };

      store.registerInFlight("cmd-1", record);

      const retrieved = store.getInFlight("cmd-1");
      assert.strictEqual(retrieved, record);
    });
  });

  describe("unregisterInFlight", () => {
    it("removes in-flight command if record matches", () => {
      const store = new CommandReplayStore();
      const record = {
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        promise: Promise.resolve(makeResponse({ command: "prompt", success: true })),
      };

      store.registerInFlight("cmd-1", record);
      store.unregisterInFlight("cmd-1", record);

      assert.strictEqual(store.getInFlight("cmd-1"), undefined);
    });

    it("does not remove if record differs (prevents race)", () => {
      const store = new CommandReplayStore();
      const record1 = {
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        promise: Promise.resolve(makeResponse({ command: "prompt", success: true })),
      };
      const record2 = {
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        promise: Promise.resolve(makeResponse({ command: "prompt", success: false })),
      };

      store.registerInFlight("cmd-1", record1);
      store.unregisterInFlight("cmd-1", record2); // Different record

      // Should still have record1
      assert.strictEqual(store.getInFlight("cmd-1"), record1);
    });
  });

  // ==========================================================================
  // REPLAY CHECK (MAIN API)
  // ==========================================================================

  describe("checkReplay", () => {
    it("returns proceed for new command", () => {
      const store = new CommandReplayStore();
      const command = makeCommand({ type: "get_state", sessionId: "s1" });
      const fingerprint = store.getCommandFingerprint(command);

      const result = store.checkReplay(command, fingerprint);
      assert.strictEqual(result.kind, "proceed");
    });

    it("returns replay_cached for idempotency key match", () => {
      const store = new CommandReplayStore();
      const command = makeCommand({ type: "get_state", sessionId: "s1", idempotencyKey: "key1" });
      const fingerprint = store.getCommandFingerprint(command);

      store.cacheIdempotencyResult({
        command,
        idempotencyKey: "key1",
        commandType: "get_state",
        fingerprint,
        response: makeResponse({ id: "original", command: "get_state", success: true }),
      });

      const result = store.checkReplay(command, fingerprint);
      assert.strictEqual(result.kind, "replay_cached");
      if (result.kind === "replay_cached") {
        assert.strictEqual(result.response.replayed, true);
      }
    });

    it("returns conflict for idempotency key with different fingerprint", () => {
      const store = new CommandReplayStore();
      const command1 = makeCommand({ type: "get_state", sessionId: "s1", idempotencyKey: "key1" });
      const command2 = makeCommand({
        type: "get_messages",
        sessionId: "s1",
        idempotencyKey: "key1",
      });
      const fp1 = store.getCommandFingerprint(command1);
      const fp2 = store.getCommandFingerprint(command2);

      store.cacheIdempotencyResult({
        command: command1,
        idempotencyKey: "key1",
        commandType: "get_state",
        fingerprint: fp1,
        response: makeResponse({ command: "get_state", success: true }),
      });

      const result = store.checkReplay(command2, fp2);
      assert.strictEqual(result.kind, "conflict");
      if (result.kind === "conflict") {
        assert.strictEqual(result.response.success, false);
        assert.ok(result.response.error?.includes("Conflicting idempotencyKey"));
      }
    });

    it("returns replay_cached for completed command ID match", () => {
      const store = new CommandReplayStore();
      const command = makeCommand({ id: "cmd-1", type: "get_state", sessionId: "s1" });
      const fingerprint = store.getCommandFingerprint(command);

      store.storeCommandOutcome({
        commandId: "cmd-1",
        commandType: "get_state",
        laneKey: "session:s1",
        fingerprint,
        success: true,
        response: makeResponse({ id: "cmd-1", command: "get_state", success: true }),
        finishedAt: Date.now(),
      });

      const result = store.checkReplay(command, fingerprint);
      assert.strictEqual(result.kind, "replay_cached");
    });

    it("returns conflict for command ID with different fingerprint", () => {
      const store = new CommandReplayStore();
      const command1 = makeCommand({ id: "cmd-1", type: "get_state", sessionId: "s1" });
      const command2 = makeCommand({ id: "cmd-1", type: "get_messages", sessionId: "s1" });
      const fp1 = store.getCommandFingerprint(command1);
      const fp2 = store.getCommandFingerprint(command2);

      store.storeCommandOutcome({
        commandId: "cmd-1",
        commandType: "get_state",
        laneKey: "session:s1",
        fingerprint: fp1,
        success: true,
        response: makeResponse({ id: "cmd-1", command: "get_state", success: true }),
        finishedAt: Date.now(),
      });

      const result = store.checkReplay(command2, fp2);
      assert.strictEqual(result.kind, "conflict");
      if (result.kind === "conflict") {
        assert.ok(result.response.error?.includes("Conflicting id"));
      }
    });

    it("returns replay for same command ID with different idempotencyKey (same semantic content)", () => {
      // This is the key fix: idempotencyKey is excluded from fingerprint
      // so same semantic command with different retry identity should replay, not conflict
      const store = new CommandReplayStore();
      const command1 = makeCommand({ id: "cmd-1", type: "get_state", sessionId: "s1" });
      const command2 = makeCommand({
        id: "cmd-1",
        type: "get_state",
        sessionId: "s1",
        idempotencyKey: "retry-key",
      });
      const fp1 = store.getCommandFingerprint(command1);
      const fp2 = store.getCommandFingerprint(command2);

      // Fingerprints should be identical (idempotencyKey excluded)
      assert.strictEqual(fp1, fp2);

      store.storeCommandOutcome({
        commandId: "cmd-1",
        commandType: "get_state",
        laneKey: "session:s1",
        fingerprint: fp1,
        success: true,
        response: makeResponse({
          id: "cmd-1",
          command: "get_state",
          success: true,
          data: { state: "ok" } as any,
        }),
        finishedAt: Date.now(),
      });

      // Should replay, not conflict
      const result = store.checkReplay(command2, fp2);
      assert.strictEqual(result.kind, "replay_cached");
      if (result.kind === "replay_cached") {
        assert.strictEqual(result.response.replayed, true);
        assert.strictEqual(result.response.success, true);
      }
    });

    it("returns replay_inflight for in-flight command ID match", async () => {
      const store = new CommandReplayStore();
      const command = makeCommand({ id: "cmd-1", type: "get_state", sessionId: "s1" });
      const fingerprint = store.getCommandFingerprint(command);

      const responsePromise = new Promise<RpcResponse>((resolve) =>
        setTimeout(
          () => resolve(makeResponse({ id: "cmd-1", command: "get_state", success: true })),
          10
        )
      );

      store.registerInFlight("cmd-1", {
        commandType: "get_state",
        laneKey: "session:s1",
        fingerprint,
        promise: responsePromise,
      });

      const result = store.checkReplay(command, fingerprint);
      assert.strictEqual(result.kind, "replay_inflight");

      if (result.kind === "replay_inflight") {
        const response = await result.promise;
        assert.strictEqual(response.replayed, true);
      }
    });

    it("returns conflict for in-flight with different fingerprint", () => {
      const store = new CommandReplayStore();
      const command1 = makeCommand({ id: "cmd-1", type: "get_state", sessionId: "s1" });
      const command2 = makeCommand({ id: "cmd-1", type: "get_messages", sessionId: "s1" });
      const fp1 = store.getCommandFingerprint(command1);
      const fp2 = store.getCommandFingerprint(command2);

      store.registerInFlight("cmd-1", {
        commandType: "get_state",
        laneKey: "session:s1",
        fingerprint: fp1,
        promise: Promise.resolve(
          makeResponse({ id: "cmd-1", command: "get_state", success: true })
        ),
      });

      const result = store.checkReplay(command2, fp2);
      assert.strictEqual(result.kind, "conflict");
    });

    it("strips ID from response when request has no ID", () => {
      const store = new CommandReplayStore();
      const commandWithId = makeCommand({
        id: "cmd-1",
        type: "get_state",
        sessionId: "s1",
        idempotencyKey: "key1",
      });
      const commandNoId = makeCommand({
        type: "get_state",
        sessionId: "s1",
        idempotencyKey: "key1",
      });
      const fingerprint = store.getCommandFingerprint(commandWithId);

      store.cacheIdempotencyResult({
        command: commandWithId,
        idempotencyKey: "key1",
        commandType: "get_state",
        fingerprint,
        response: makeResponse({ id: "cmd-1", command: "get_state", success: true }),
      });

      const result = store.checkReplay(commandNoId, fingerprint);
      assert.strictEqual(result.kind, "replay_cached");
      if (result.kind === "replay_cached") {
        assert.strictEqual(result.response.id, undefined);
      }
    });

    it("preserves ID in response when request has ID", () => {
      const store = new CommandReplayStore();
      const command1 = makeCommand({
        id: "original",
        type: "get_state",
        sessionId: "s1",
        idempotencyKey: "key1",
      });
      const command2 = makeCommand({
        id: "new-request",
        type: "get_state",
        sessionId: "s1",
        idempotencyKey: "key1",
      });
      const fingerprint = store.getCommandFingerprint(command1);

      store.cacheIdempotencyResult({
        command: command1,
        idempotencyKey: "key1",
        commandType: "get_state",
        fingerprint,
        response: makeResponse({ id: "original", command: "get_state", success: true }),
      });

      const result = store.checkReplay(command2, fingerprint);
      assert.strictEqual(result.kind, "replay_cached");
      if (result.kind === "replay_cached") {
        assert.strictEqual(result.response.id, "new-request");
      }
    });
  });

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  describe("clear", () => {
    it("clears all state", async () => {
      const store = new CommandReplayStore();

      // Add some state
      const command = makeCommand({
        id: "cmd-1",
        type: "get_state",
        sessionId: "s1",
        idempotencyKey: "key1",
      });
      const fingerprint = store.getCommandFingerprint(command);

      store.cacheIdempotencyResult({
        command,
        idempotencyKey: "key1",
        commandType: "get_state",
        fingerprint,
        response: makeResponse({ command: "get_state", success: true }),
      });

      store.storeCommandOutcome({
        commandId: "cmd-1",
        commandType: "get_state",
        laneKey: "session:s1",
        fingerprint,
        success: true,
        response: makeResponse({ command: "get_state", success: true }),
        finishedAt: Date.now(),
      });

      store.registerInFlight("cmd-2", {
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp2",
        promise: Promise.resolve(makeResponse({ command: "prompt", success: true })),
      });

      store.clear();

      // Verify all cleared
      assert.strictEqual(store.getCommandOutcome("cmd-1"), undefined);
      assert.strictEqual(store.getInFlight("cmd-2"), undefined);

      const result = store.checkReplay(command, fingerprint);
      assert.strictEqual(result.kind, "proceed");
    });

    it("synthetic IDs remain unique after clear", () => {
      const store = new CommandReplayStore();
      const id1 = store.getOrCreateCommandId(makeCommand({ type: "get_state" }));
      const id2 = store.getOrCreateCommandId(makeCommand({ type: "get_state" }));

      // Extract sequence numbers (format: anon:timestamp:sequence)
      const seq1 = parseInt(id1.split(":")[2], 10);
      const seq2 = parseInt(id2.split(":")[2], 10);
      assert.strictEqual(seq2, seq1 + 1);

      store.clear();

      const id3 = store.getOrCreateCommandId(makeCommand({ type: "get_state" }));
      // After clear, sequence continues (doesn't reset) - processStartTime ensures uniqueness
      const seq3 = parseInt(id3.split(":")[2], 10);
      assert.strictEqual(seq3, seq2 + 1, "Sequence should continue after clear");

      // All IDs should be unique
      assert.notStrictEqual(id1, id2);
      assert.notStrictEqual(id2, id3);
      assert.notStrictEqual(id1, id3);
    });
  });

  // ==========================================================================
  // BOUNDED OUTCOMES
  // ==========================================================================

  describe("bounded outcome retention", () => {
    it("trims old outcomes when limit exceeded", () => {
      const store = new CommandReplayStore({ maxCommandOutcomes: 5 });

      // Store 7 outcomes
      for (let i = 1; i <= 7; i++) {
        store.storeCommandOutcome({
          commandId: `cmd-${i}`,
          commandType: "get_state",
          laneKey: "session:s1",
          fingerprint: `fp-${i}`,
          success: true,
          response: makeResponse({ command: "get_state", success: true }),
          finishedAt: Date.now(),
        });
      }

      // First 2 should be trimmed
      assert.strictEqual(store.getCommandOutcome("cmd-1"), undefined);
      assert.strictEqual(store.getCommandOutcome("cmd-2"), undefined);

      // Last 5 should remain
      for (let i = 3; i <= 7; i++) {
        assert.ok(store.getCommandOutcome(`cmd-${i}`), `cmd-${i} should exist`);
      }
    });
  });

  // ==========================================================================
  // BOUNDED IN-FLIGHT COMMANDS (ADR-0001: Reject, don't evict)
  // ==========================================================================

  describe("bounded in-flight commands", () => {
    it("rejects new in-flight commands when limit exceeded", () => {
      const store = new CommandReplayStore({ maxInFlightCommands: 3 });

      // Register 3 in-flight commands (should succeed)
      for (let i = 1; i <= 3; i++) {
        const result = store.registerInFlight(`inflight-${i}`, {
          commandType: "prompt",
          laneKey: `session:s${i}`,
          fingerprint: `fp-${i}`,
          promise: new Promise(() => {}),
        });
        assert.strictEqual(result, true, `inflight-${i} should be registered`);
      }

      // Attempting to register more should fail (reject, not evict)
      const result = store.registerInFlight(`inflight-4`, {
        commandType: "prompt",
        laneKey: `session:s4`,
        fingerprint: `fp-4`,
        promise: new Promise(() => {}),
      });
      assert.strictEqual(result, false, "Should reject when limit reached");

      // Original 3 should still exist (not evicted)
      for (let i = 1; i <= 3; i++) {
        assert.ok(store.getInFlight(`inflight-${i}`), `inflight-${i} should still exist`);
      }

      // Rejected command should not exist
      assert.strictEqual(store.getInFlight("inflight-4"), undefined);
    });

    it("tracks in-flight rejections in stats", () => {
      const store = new CommandReplayStore({ maxInFlightCommands: 2 });

      // Register 2 in-flight commands (succeeds)
      store.registerInFlight(`inflight-1`, {
        commandType: "prompt",
        laneKey: `session:s1`,
        fingerprint: `fp-1`,
        promise: new Promise(() => {}),
      });
      store.registerInFlight(`inflight-2`, {
        commandType: "prompt",
        laneKey: `session:s2`,
        fingerprint: `fp-2`,
        promise: new Promise(() => {}),
      });

      // Attempt 2 more (should be rejected)
      const r1 = store.registerInFlight(`inflight-3`, {
        commandType: "prompt",
        laneKey: `session:s3`,
        fingerprint: `fp-3`,
        promise: new Promise(() => {}),
      });
      const r2 = store.registerInFlight(`inflight-4`, {
        commandType: "prompt",
        laneKey: `session:s4`,
        fingerprint: `fp-4`,
        promise: new Promise(() => {}),
      });

      assert.strictEqual(r1, false);
      assert.strictEqual(r2, false);

      const stats = store.getStats();
      assert.strictEqual(stats.inFlightRejections, 2);
      assert.strictEqual(stats.inFlightCount, 2);
    });

    it("allows re-registration of existing ID", () => {
      const store = new CommandReplayStore({ maxInFlightCommands: 1 });

      // Register first
      const r1 = store.registerInFlight(`cmd-1`, {
        commandType: "prompt",
        laneKey: `session:s1`,
        fingerprint: `fp-1`,
        promise: new Promise(() => {}),
      });
      assert.strictEqual(r1, true);

      // Re-register same ID (should succeed - it's an update)
      const r2 = store.registerInFlight(`cmd-1`, {
        commandType: "prompt",
        laneKey: `session:s1`,
        fingerprint: `fp-1`,
        promise: new Promise(() => {}),
      });
      assert.strictEqual(r2, true);
    });
  });

  // ==========================================================================
  // STATS
  // ==========================================================================

  describe("getStats", () => {
    it("returns empty stats for new store", () => {
      const store = new CommandReplayStore();
      const stats = store.getStats();

      assert.strictEqual(stats.inFlightCount, 0);
      assert.strictEqual(stats.outcomeCount, 0);
      assert.strictEqual(stats.idempotencyCacheSize, 0);
      assert.strictEqual(stats.inFlightRejections, 0);
    });

    it("tracks all store sizes", () => {
      const store = new CommandReplayStore();
      const command = makeCommand({ type: "get_state", sessionId: "s1", idempotencyKey: "key1" });
      const fingerprint = store.getCommandFingerprint(command);

      // Add in-flight
      store.registerInFlight("cmd-1", {
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        promise: new Promise(() => {}),
      });

      // Add outcome
      store.storeCommandOutcome({
        commandId: "cmd-1",
        commandType: "prompt",
        laneKey: "session:s1",
        fingerprint: "fp1",
        success: true,
        response: makeResponse({ command: "prompt", success: true }),
        finishedAt: Date.now(),
      });

      // Add idempotency cache entry
      store.cacheIdempotencyResult({
        command,
        idempotencyKey: "key1",
        commandType: "get_state",
        fingerprint,
        response: makeResponse({ command: "get_state", success: true }),
      });

      const stats = store.getStats();
      assert.strictEqual(stats.inFlightCount, 1);
      assert.strictEqual(stats.outcomeCount, 1);
      assert.strictEqual(stats.idempotencyCacheSize, 1);
    });
  });
});
