/**
 * Unit tests for command-classification.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
  getCommandTimeoutPolicy,
  isShortTimeoutCommand,
  isNoTimeoutCommand,
  isMutationCommand,
  isReadOnlyCommand,
  getCommandExecutionPlane,
  getRateLimitTarget,
  classifyCommand,
} from "./command-classification.js";

describe("command-classification", () => {
  // ==========================================================================
  // TIMEOUT CLASSIFICATION
  // ==========================================================================

  describe("getCommandTimeoutPolicy", () => {
    it("returns null for non-timeout-wrapped mutation commands", () => {
      assert.strictEqual(getCommandTimeoutPolicy("create_session"), null);
      assert.strictEqual(getCommandTimeoutPolicy("delete_session"), null);
      assert.strictEqual(getCommandTimeoutPolicy("load_session"), null);
      assert.strictEqual(getCommandTimeoutPolicy("set_session_name"), null);
    });

    it("returns short timeout for short-timeout commands", () => {
      const result = getCommandTimeoutPolicy("get_state");
      assert.strictEqual(result, 30000); // default short timeout
    });

    it("returns default timeout for other commands", () => {
      const result = getCommandTimeoutPolicy("prompt");
      assert.strictEqual(result, 300000); // default long timeout (5 min)
    });

    it("respects custom timeout options", () => {
      const shortResult = getCommandTimeoutPolicy("get_state", {
        shortTimeoutMs: 1000,
        defaultTimeoutMs: 10000,
      });
      assert.strictEqual(shortResult, 1000);

      const longResult = getCommandTimeoutPolicy("prompt", {
        shortTimeoutMs: 1000,
        defaultTimeoutMs: 10000,
      });
      assert.strictEqual(longResult, 10000);
    });

    it("returns null for no-timeout commands even with custom options", () => {
      const result = getCommandTimeoutPolicy("create_session", {
        shortTimeoutMs: 1000,
        defaultTimeoutMs: 10000,
      });
      assert.strictEqual(result, null);
    });
  });

  describe("isShortTimeoutCommand", () => {
    it("returns true for get_state", () => {
      assert.strictEqual(isShortTimeoutCommand("get_state"), true);
    });

    it("returns true for get_messages", () => {
      assert.strictEqual(isShortTimeoutCommand("get_messages"), true);
    });

    it("returns true for get_available_models", () => {
      assert.strictEqual(isShortTimeoutCommand("get_available_models"), true);
    });

    it("returns true for get_commands", () => {
      assert.strictEqual(isShortTimeoutCommand("get_commands"), true);
    });

    it("returns true for get_skills", () => {
      assert.strictEqual(isShortTimeoutCommand("get_skills"), true);
    });

    it("returns true for get_tools", () => {
      assert.strictEqual(isShortTimeoutCommand("get_tools"), true);
    });

    it("returns true for list_session_files", () => {
      assert.strictEqual(isShortTimeoutCommand("list_session_files"), true);
    });

    it("returns true for get_session_stats", () => {
      assert.strictEqual(isShortTimeoutCommand("get_session_stats"), true);
    });

    it("returns true for get_fork_messages", () => {
      assert.strictEqual(isShortTimeoutCommand("get_fork_messages"), true);
    });

    it("returns true for get_tree", () => {
      assert.strictEqual(isShortTimeoutCommand("get_tree"), true);
    });

    it("returns true for get_last_assistant_text", () => {
      assert.strictEqual(isShortTimeoutCommand("get_last_assistant_text"), true);
    });

    it("returns true for get_context_usage", () => {
      assert.strictEqual(isShortTimeoutCommand("get_context_usage"), true);
    });

    it("returns false for set_session_name", () => {
      assert.strictEqual(isShortTimeoutCommand("set_session_name"), false);
    });

    it("returns true for get_startup_recovery", () => {
      assert.strictEqual(isShortTimeoutCommand("get_startup_recovery"), true);
    });

    it("returns true for get_command_history", () => {
      assert.strictEqual(isShortTimeoutCommand("get_command_history"), true);
    });

    it("returns false for prompt", () => {
      assert.strictEqual(isShortTimeoutCommand("prompt"), false);
    });

    it("returns false for steer", () => {
      assert.strictEqual(isShortTimeoutCommand("steer"), false);
    });

    it("returns false for unknown command", () => {
      assert.strictEqual(isShortTimeoutCommand("unknown_command"), false);
    });
  });

  describe("isNoTimeoutCommand", () => {
    it("returns true for mutation commands that must not commit after timeout", () => {
      assert.strictEqual(isNoTimeoutCommand("create_session"), true);
      assert.strictEqual(isNoTimeoutCommand("delete_session"), true);
      assert.strictEqual(isNoTimeoutCommand("load_session"), true);
      assert.strictEqual(isNoTimeoutCommand("set_session_name"), true);
    });

    it("returns false for prompt", () => {
      assert.strictEqual(isNoTimeoutCommand("prompt"), false);
    });

    it("returns false for get_state", () => {
      assert.strictEqual(isNoTimeoutCommand("get_state"), false);
    });
  });

  // ==========================================================================
  // MUTATION CLASSIFICATION
  // ==========================================================================

  describe("isMutationCommand", () => {
    it("returns false for read-only commands", () => {
      assert.strictEqual(isMutationCommand("get_state"), false);
      assert.strictEqual(isMutationCommand("get_messages"), false);
      assert.strictEqual(isMutationCommand("get_available_models"), false);
      assert.strictEqual(isMutationCommand("get_commands"), false);
      assert.strictEqual(isMutationCommand("get_skills"), false);
      assert.strictEqual(isMutationCommand("get_tools"), false);
      assert.strictEqual(isMutationCommand("list_session_files"), false);
      assert.strictEqual(isMutationCommand("get_session_stats"), false);
      assert.strictEqual(isMutationCommand("get_fork_messages"), false);
      assert.strictEqual(isMutationCommand("get_last_assistant_text"), false);
      assert.strictEqual(isMutationCommand("get_tree"), false);
      assert.strictEqual(isMutationCommand("get_context_usage"), false);
      assert.strictEqual(isMutationCommand("switch_session"), false);
    });

    it("returns false for extension_ui_response", () => {
      assert.strictEqual(isMutationCommand("extension_ui_response"), false);
    });

    it("returns true for mutating commands", () => {
      assert.strictEqual(isMutationCommand("prompt"), true);
      assert.strictEqual(isMutationCommand("steer"), true);
      assert.strictEqual(isMutationCommand("follow_up"), true);
      assert.strictEqual(isMutationCommand("abort"), true);
      assert.strictEqual(isMutationCommand("set_model"), true);
      assert.strictEqual(isMutationCommand("compact"), true);
      assert.strictEqual(isMutationCommand("bash"), true);
      assert.strictEqual(isMutationCommand("delete_session"), true);
    });

    it("returns true for unknown commands (safe default)", () => {
      assert.strictEqual(isMutationCommand("unknown_command"), true);
    });
  });

  describe("isReadOnlyCommand", () => {
    it("returns true for read-only commands", () => {
      assert.strictEqual(isReadOnlyCommand("get_state"), true);
      assert.strictEqual(isReadOnlyCommand("get_messages"), true);
      assert.strictEqual(isReadOnlyCommand("switch_session"), true);
      assert.strictEqual(isReadOnlyCommand("get_tree"), true);
    });

    it("returns false for mutating commands", () => {
      assert.strictEqual(isReadOnlyCommand("prompt"), false);
      assert.strictEqual(isReadOnlyCommand("set_model"), false);
    });

    it("returns false for extension_ui_response", () => {
      assert.strictEqual(isReadOnlyCommand("extension_ui_response"), false);
    });
  });

  // ==========================================================================
  // EXECUTION PLANE / RATE LIMITING
  // ==========================================================================

  describe("getCommandExecutionPlane", () => {
    it("classifies server lifecycle commands as control-plane", () => {
      assert.strictEqual(getCommandExecutionPlane("create_session"), "control");
      assert.strictEqual(getCommandExecutionPlane("delete_session"), "control");
      assert.strictEqual(getCommandExecutionPlane("get_command_history"), "control");
    });

    it("classifies session work commands as data-plane", () => {
      assert.strictEqual(getCommandExecutionPlane("prompt"), "data");
      assert.strictEqual(getCommandExecutionPlane("get_state"), "data");
      assert.strictEqual(getCommandExecutionPlane("extension_ui_response"), "data");
    });
  });

  describe("getRateLimitTarget", () => {
    it("uses dedicated control buckets for targeted control-plane commands", () => {
      assert.deepStrictEqual(
        getRateLimitTarget({ type: "delete_session", sessionId: "s1" } as any),
        { plane: "control", key: "control:s1" }
      );
      assert.deepStrictEqual(
        getRateLimitTarget({ type: "switch_session", sessionId: "s1" } as any),
        { plane: "control", key: "control:s1" }
      );
    });

    it("uses shared server control bucket for untargeted control-plane commands", () => {
      assert.deepStrictEqual(getRateLimitTarget({ type: "list_sessions" } as any), {
        plane: "control",
        key: "_server_control_",
      });
      assert.deepStrictEqual(
        getRateLimitTarget({ type: "load_session", sessionId: "future-id" } as any),
        { plane: "control", key: "_server_control_" }
      );
    });

    it("keeps session data-plane commands on per-session buckets", () => {
      assert.deepStrictEqual(getRateLimitTarget({ type: "get_state", sessionId: "s1" } as any), {
        plane: "data",
        key: "s1",
      });
    });
  });

  // ==========================================================================
  // COMBINED CLASSIFICATION
  // ==========================================================================

  describe("classifyCommand", () => {
    it("classifies get_state correctly", () => {
      const classification = classifyCommand("get_state");
      assert.strictEqual(classification.timeoutMs, 30000);
      assert.strictEqual(classification.isShortTimeout, true);
      assert.strictEqual(classification.isCancellable, true);
      assert.strictEqual(classification.isMutation, false);
      assert.strictEqual(classification.isReadOnly, true);
      assert.strictEqual(classification.executionPlane, "data");
    });

    it("classifies get_tree as read-only", () => {
      const classification = classifyCommand("get_tree");
      assert.strictEqual(classification.timeoutMs, 30000);
      assert.strictEqual(classification.isShortTimeout, true);
      assert.strictEqual(classification.isMutation, false);
      assert.strictEqual(classification.isReadOnly, true);
    });

    it("classifies prompt correctly", () => {
      const classification = classifyCommand("prompt");
      assert.strictEqual(classification.timeoutMs, 300000);
      assert.strictEqual(classification.isShortTimeout, false);
      assert.strictEqual(classification.isCancellable, true);
      assert.strictEqual(classification.isMutation, true);
      assert.strictEqual(classification.isReadOnly, false);
    });

    it("classifies create_session correctly", () => {
      const classification = classifyCommand("create_session");
      assert.strictEqual(classification.timeoutMs, null);
      assert.strictEqual(classification.isShortTimeout, false);
      assert.strictEqual(classification.isCancellable, false);
      assert.strictEqual(classification.abortability, "non_abortable");
      assert.strictEqual(classification.isMutation, true); // creates state
      assert.strictEqual(classification.isReadOnly, false);
      assert.strictEqual(classification.executionPlane, "control");
    });

    it("classifies delete_session as non-timeout-wrapped control mutation", () => {
      const classification = classifyCommand("delete_session");
      assert.strictEqual(classification.timeoutMs, null);
      assert.strictEqual(classification.isCancellable, false);
      assert.strictEqual(classification.abortability, "non_abortable");
      assert.strictEqual(classification.isMutation, true);
      assert.strictEqual(classification.executionPlane, "control");
    });

    it("respects custom options", () => {
      const classification = classifyCommand("prompt", {
        shortTimeoutMs: 1000,
        defaultTimeoutMs: 10000,
      });
      assert.strictEqual(classification.timeoutMs, 10000);
    });
  });
});
