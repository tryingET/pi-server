/**
 * Unit tests for session-version-store.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { SessionVersionStore } from "./session-version-store.js";

describe("session-version-store", () => {
  // ==========================================================================
  // VERSION ACCESS
  // ==========================================================================

  describe("getVersion", () => {
    it("returns undefined for non-existent session", () => {
      const store = new SessionVersionStore();
      assert.strictEqual(store.getVersion("non-existent"), undefined);
    });

    it("returns version after initialization", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      assert.strictEqual(store.getVersion("session-1"), 0);
    });
  });

  describe("hasVersion", () => {
    it("returns false for non-existent session", () => {
      const store = new SessionVersionStore();
      assert.strictEqual(store.hasVersion("non-existent"), false);
    });

    it("returns true after initialization", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      assert.strictEqual(store.hasVersion("session-1"), true);
    });
  });

  // ==========================================================================
  // VERSION MUTATION
  // ==========================================================================

  describe("initialize", () => {
    it("sets version to 0", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      assert.strictEqual(store.getVersion("session-1"), 0);
    });

    it("can be called multiple times (resets to 0)", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      store.increment("session-1");
      store.initialize("session-1");
      assert.strictEqual(store.getVersion("session-1"), 0);
    });
  });

  describe("increment", () => {
    it("increments from 0 to 1", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      const result = store.increment("session-1");
      assert.strictEqual(result, 1);
      assert.strictEqual(store.getVersion("session-1"), 1);
    });

    it("returns new version", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      store.increment("session-1");
      assert.strictEqual(store.increment("session-1"), 2);
    });

    it("handles missing session (starts from 0)", () => {
      const store = new SessionVersionStore();
      const result = store.increment("no-init");
      assert.strictEqual(result, 1);
    });
  });

  describe("set", () => {
    it("sets version explicitly", () => {
      const store = new SessionVersionStore();
      store.set("session-1", 42);
      assert.strictEqual(store.getVersion("session-1"), 42);
    });

    it("overwrites existing version", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      store.set("session-1", 100);
      assert.strictEqual(store.getVersion("session-1"), 100);
    });
  });

  describe("delete", () => {
    it("removes version record", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      store.delete("session-1");
      assert.strictEqual(store.hasVersion("session-1"), false);
    });

    it("is idempotent", () => {
      const store = new SessionVersionStore();
      store.delete("non-existent"); // should not throw
      assert.strictEqual(store.hasVersion("non-existent"), false);
    });
  });

  describe("clear", () => {
    it("removes all version records", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      store.initialize("session-2");
      store.initialize("session-3");
      store.clear();
      assert.strictEqual(store.hasVersion("session-1"), false);
      assert.strictEqual(store.hasVersion("session-2"), false);
      assert.strictEqual(store.hasVersion("session-3"), false);
    });
  });

  // ==========================================================================
  // COMMAND CLASSIFICATION (delegates to command-classification.ts)
  // ==========================================================================

  describe("isMutation", () => {
    it("returns false for read-only commands", () => {
      const store = new SessionVersionStore();
      assert.strictEqual(store.isMutation("get_state"), false);
      assert.strictEqual(store.isMutation("get_messages"), false);
      assert.strictEqual(store.isMutation("switch_session"), false);
    });

    it("returns true for mutating commands", () => {
      const store = new SessionVersionStore();
      assert.strictEqual(store.isMutation("prompt"), true);
      assert.strictEqual(store.isMutation("steer"), true);
      assert.strictEqual(store.isMutation("set_model"), true);
    });

    it("returns false for extension_ui_response", () => {
      const store = new SessionVersionStore();
      assert.strictEqual(store.isMutation("extension_ui_response"), false);
    });
  });

  // ==========================================================================
  // RESPONSE VERSIONING
  // ==========================================================================

  describe("applyVersion", () => {
    it("returns failed responses unchanged", () => {
      const store = new SessionVersionStore();
      const response = {
        type: "response" as const,
        command: "prompt",
        success: false,
        error: "Something failed",
      } as any;
      const result = store.applyVersion({ type: "prompt", sessionId: "s1" } as any, response);
      assert.strictEqual(result, response);
      assert.strictEqual("sessionVersion" in result, false);
    });

    it("initializes version for create_session", () => {
      const store = new SessionVersionStore();
      const response = {
        type: "response" as const,
        command: "create_session",
        success: true,
        data: { sessionId: "new-session", sessionInfo: {} as any },
      } as any;
      const result = store.applyVersion({ type: "create_session" } as any, response);
      assert.strictEqual(result.sessionVersion, 0);
      assert.strictEqual(store.getVersion("new-session"), 0);
    });

    it("initializes version for load_session", () => {
      const store = new SessionVersionStore();
      const response = {
        type: "response" as const,
        command: "load_session",
        success: true,
        data: { sessionId: "loaded-session", sessionInfo: {} as any },
      } as any;
      const result = store.applyVersion(
        { type: "load_session", sessionPath: "/tmp/s.jsonl" } as any,
        response
      );
      assert.strictEqual(result.sessionVersion, 0);
      assert.strictEqual(store.getVersion("loaded-session"), 0);
    });

    it("deletes version for delete_session", () => {
      const store = new SessionVersionStore();
      store.initialize("session-to-delete");
      const response = {
        type: "response" as const,
        command: "delete_session",
        success: true,
        data: { deleted: true },
      } as any;
      const result = store.applyVersion(
        { type: "delete_session", sessionId: "session-to-delete" } as any,
        response
      );
      assert.strictEqual("sessionVersion" in result, false);
      assert.strictEqual(store.hasVersion("session-to-delete"), false);
    });

    it("increments version for mutating commands", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      const response = {
        type: "response" as const,
        command: "prompt",
        success: true,
      } as any;
      const result = store.applyVersion(
        { type: "prompt", sessionId: "session-1" } as any,
        response
      );
      assert.strictEqual(result.sessionVersion, 1);
      assert.strictEqual(store.getVersion("session-1"), 1);
    });

    it("does not increment version for read-only commands", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      const response = {
        type: "response" as const,
        command: "get_state",
        success: true,
        data: {} as any,
      } as any;
      const result = store.applyVersion(
        { type: "get_state", sessionId: "session-1" } as any,
        response
      );
      assert.strictEqual(result.sessionVersion, 0);
      assert.strictEqual(store.getVersion("session-1"), 0);
    });

    it("does not increment version for extension_ui_response", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      const response = {
        type: "response" as const,
        command: "extension_ui_response",
        success: true,
      } as any;
      const result = store.applyVersion(
        {
          type: "extension_ui_response",
          sessionId: "session-1",
          requestId: "r1",
          response: { method: "cancelled" },
        } as any,
        response
      );
      assert.strictEqual(result.sessionVersion, 0);
    });

    it("returns response without version for server commands without sessionId", () => {
      const store = new SessionVersionStore();
      const response = {
        type: "response" as const,
        command: "list_sessions",
        success: true,
        data: { sessions: [] },
      } as any;
      const result = store.applyVersion({ type: "list_sessions" } as any, response);
      assert.strictEqual("sessionVersion" in result, false);
    });

    it("handles missing session gracefully", () => {
      const store = new SessionVersionStore();
      // Don't initialize the session
      const response = {
        type: "response" as const,
        command: "prompt",
        success: true,
      } as any;
      const result = store.applyVersion(
        { type: "prompt", sessionId: "unknown-session" } as any,
        response
      );
      // Should still work, treating as starting from 0
      assert.strictEqual(result.sessionVersion, 1);
    });
  });

  // ==========================================================================
  // STATS
  // ==========================================================================

  describe("getStats", () => {
    it("returns zero count for empty store", () => {
      const store = new SessionVersionStore();
      const stats = store.getStats();
      assert.strictEqual(stats.sessionCount, 0);
    });

    it("tracks session count", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      store.initialize("session-2");
      store.initialize("session-3");
      const stats = store.getStats();
      assert.strictEqual(stats.sessionCount, 3);
    });

    it("decrements count on delete", () => {
      const store = new SessionVersionStore();
      store.initialize("session-1");
      store.initialize("session-2");
      store.delete("session-1");
      const stats = store.getStats();
      assert.strictEqual(stats.sessionCount, 1);
    });
  });
});
