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
  classifyCommand,
} from "./command-classification.js";

describe("command-classification", () => {
  // ==========================================================================
  // TIMEOUT CLASSIFICATION
  // ==========================================================================

  describe("getCommandTimeoutPolicy", () => {
    it("returns null for no-timeout commands", () => {
      assert.strictEqual(getCommandTimeoutPolicy("create_session"), null);
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

    it("returns true for get_last_assistant_text", () => {
      assert.strictEqual(isShortTimeoutCommand("get_last_assistant_text"), true);
    });

    it("returns true for get_context_usage", () => {
      assert.strictEqual(isShortTimeoutCommand("get_context_usage"), true);
    });

    it("returns true for set_session_name", () => {
      assert.strictEqual(isShortTimeoutCommand("set_session_name"), true);
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
    it("returns true for create_session", () => {
      assert.strictEqual(isNoTimeoutCommand("create_session"), true);
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
      assert.strictEqual(classification.isMutation, true); // creates state
      assert.strictEqual(classification.isReadOnly, false);
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
