/**
 * Basic tests for pi-server.
 *
 * Run with: node --experimental-vm-modules dist/test.js
 *
 * Tests:
 * - Validation module
 * - Command routing
 * - Session lifecycle (requires pi-coding-agent)
 */

import assert from "assert";
import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

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
// VALIDATION TESTS
// =============================================================================

import { validateCommand, formatValidationErrors } from "./validation.js";

async function testValidation() {
  console.log("\n=== Validation Tests ===\n");

  // Test: Missing type
  await test("validation: rejects missing type", () => {
    const errors = validateCommand({});
    assert(errors.length > 0, "Should have errors");
    assert(
      errors.some((e) => e.field === "type"),
      "Should have type error"
    );
  });

  // Test: Missing sessionId for session commands
  await test("validation: rejects missing sessionId", () => {
    const errors = validateCommand({ type: "get_state" });
    assert(errors.length > 0, "Should have errors");
    assert(
      errors.some((e) => e.field === "sessionId"),
      "Should have sessionId error"
    );
  });

  // Test: Empty sessionId
  await test("validation: rejects empty sessionId", () => {
    const errors = validateCommand({ type: "get_state", sessionId: "" });
    assert(errors.length > 0, "Should have errors");
    assert(
      errors.some((e) => e.field === "sessionId"),
      "Should have sessionId error"
    );
  });

  // Test: Valid list_sessions command (no sessionId required)
  await test("validation: accepts list_sessions without sessionId", () => {
    const errors = validateCommand({ type: "list_sessions" });
    assert.strictEqual(errors.length, 0, "Should have no errors");
  });

  await test("validation: accepts get_startup_recovery without sessionId", () => {
    const errors = validateCommand({ type: "get_startup_recovery" });
    assert.strictEqual(errors.length, 0, "Should have no errors");
  });

  await test("validation: accepts get_command_history filters", () => {
    const errors = validateCommand({
      type: "get_command_history",
      sessionIdFilter: "s1",
      commandId: "cmd-1",
      fromTimestamp: 100,
      toTimestamp: 200,
      limit: 25,
    });
    assert.strictEqual(errors.length, 0, "Should have no errors");
  });

  await test("validation: rejects get_command_history with invalid limit", () => {
    const errors = validateCommand({
      type: "get_command_history",
      limit: 0,
    });
    assert(
      errors.some((e) => e.field === "limit"),
      "Should have limit error"
    );
  });

  await test("validation: rejects get_command_history with invalid time window", () => {
    const errors = validateCommand({
      type: "get_command_history",
      fromTimestamp: 200,
      toTimestamp: 100,
    });
    assert(
      errors.some((e) => e.field === "fromTimestamp"),
      "Should have fromTimestamp error"
    );
  });

  // Test: Valid create_session with sessionId
  await test("validation: accepts create_session with sessionId", () => {
    const errors = validateCommand({ type: "create_session", sessionId: "test" });
    assert.strictEqual(errors.length, 0, "Should have no errors");
  });

  // Test: Missing message for prompt
  await test("validation: rejects prompt without message", () => {
    const errors = validateCommand({ type: "prompt", sessionId: "test" });
    assert(errors.length > 0, "Should have errors");
    assert(
      errors.some((e) => e.field === "message"),
      "Should have message error"
    );
  });

  // Test: Valid prompt
  await test("validation: accepts valid prompt", () => {
    const errors = validateCommand({ type: "prompt", sessionId: "test", message: "hello" });
    assert.strictEqual(errors.length, 0, "Should have no errors");
  });

  // Test: set_model missing fields
  await test("validation: rejects set_model without provider/modelId", () => {
    const errors = validateCommand({ type: "set_model", sessionId: "test" });
    assert(
      errors.some((e) => e.field === "provider"),
      "Should have provider error"
    );
    assert(
      errors.some((e) => e.field === "modelId"),
      "Should have modelId error"
    );
  });

  // Test: Valid set_model
  await test("validation: accepts valid set_model", () => {
    const errors = validateCommand({
      type: "set_model",
      sessionId: "test",
      provider: "anthropic",
      modelId: "claude-3-opus",
    });
    assert.strictEqual(errors.length, 0, "Should have no errors");
  });

  // Test: Invalid thinking level
  await test("validation: rejects invalid thinking level", () => {
    const errors = validateCommand({
      type: "set_thinking_level",
      sessionId: "test",
      level: "invalid",
    });
    assert(
      errors.some((e) => e.field === "level"),
      "Should have level error"
    );
  });

  // Test: Valid thinking level
  await test("validation: accepts valid thinking level", () => {
    const errors = validateCommand({
      type: "set_thinking_level",
      sessionId: "test",
      level: "high",
    });
    assert.strictEqual(errors.length, 0, "Should have no errors");
  });

  // Test: extension_ui_response validation
  await test("validation: rejects extension_ui_response without requestId", () => {
    const errors = validateCommand({
      type: "extension_ui_response",
      sessionId: "test",
      response: { method: "cancelled" },
    });
    assert(
      errors.some((e) => e.field === "requestId"),
      "Should have requestId error"
    );
  });

  await test("validation: rejects extension_ui_response with invalid method", () => {
    const errors = validateCommand({
      type: "extension_ui_response",
      sessionId: "test",
      requestId: "req1",
      response: { method: "bad_method" },
    });
    assert(
      errors.some((e) => e.field === "response.method"),
      "Should have response.method error"
    );
  });

  await test("validation: rejects overly long requestId", () => {
    const errors = validateCommand({
      type: "extension_ui_response",
      sessionId: "test",
      requestId: "a".repeat(300),
      response: { method: "cancelled" },
    });
    assert(
      errors.some((e) => e.field === "requestId" && e.message.includes("Too long")),
      "Should reject overly long requestId"
    );
  });

  await test("validation: rejects requestId with invalid characters", () => {
    const errors = validateCommand({
      type: "extension_ui_response",
      sessionId: "test",
      requestId: "req'; DROP TABLE--",
      response: { method: "cancelled" },
    });
    assert(
      errors.some((e) => e.field === "requestId" && e.message.includes("alphanumeric")),
      "Should reject requestId with invalid characters"
    );
  });

  await test("validation: accepts valid requestId formats", () => {
    // requestId from ExtensionUIManager uses format: sessionId:timestamp:random
    const validIds = [
      "session-1:1234567890:abc123",
      "simple-request",
      "req_123",
      "req:with:colons",
    ];
    for (const requestId of validIds) {
      const errors = validateCommand({
        type: "extension_ui_response",
        sessionId: "test",
        requestId,
        response: { method: "cancelled" },
      });
      assert(
        !errors.some((e) => e.field === "requestId"),
        `Should accept requestId "${requestId}"`
      );
    }
  });

  await test("validation: rejects unknown command type", () => {
    const errors = validateCommand({ type: "totally_unknown", sessionId: "x" });
    assert(
      errors.some((e) => e.field === "type"),
      "Should reject unknown command type"
    );
  });

  await test("validation: dependsOn requires command id", () => {
    const errors = validateCommand({ type: "list_sessions", dependsOn: ["abc"] });
    assert(
      errors.some((e) => e.field === "id"),
      "Should require id when dependsOn is present"
    );
  });

  await test("validation: dependsOn bounds enforced", () => {
    // Create an array that exceeds MAX_DEPENDENCIES (32)
    const tooManyDeps = Array.from({ length: 50 }, (_, i) => `dep-${i}`);
    const errors = validateCommand({
      type: "list_sessions",
      id: "cmd-1",
      dependsOn: tooManyDeps,
    });
    assert(
      errors.some((e) => e.field === "dependsOn" && e.message.includes("Too many")),
      "Should reject too many dependencies"
    );
  });

  await test("validation: dependsOn elements must be non-empty strings", () => {
    const errors = validateCommand({
      type: "list_sessions",
      id: "cmd-1",
      dependsOn: ["valid", "", "also-valid"],
    });
    assert(
      errors.some((e) => e.field === "dependsOn[1]" && e.message.includes("non-empty")),
      "Should reject empty string in dependsOn"
    );
  });

  await test("validation: validates idempotency key type", () => {
    const errors = validateCommand({
      type: "list_sessions",
      id: "x",
      idempotencyKey: 42,
    } as any);
    assert(
      errors.some((e) => e.field === "idempotencyKey"),
      "Should reject invalid idempotencyKey type"
    );
  });

  await test("validation: validates ifSessionVersion", () => {
    const errors = validateCommand({
      type: "get_state",
      sessionId: "test",
      ifSessionVersion: -1,
    });
    assert(
      errors.some((e) => e.field === "ifSessionVersion"),
      "Should reject negative version"
    );
  });

  await test("validation: rejects ifSessionVersion on non-session command", () => {
    const errors = validateCommand({
      type: "list_sessions",
      ifSessionVersion: 1,
    });
    assert(
      errors.some((e) => e.field === "ifSessionVersion"),
      "Should reject ifSessionVersion for non-session commands"
    );
  });

  await test("validation: rejects overly long prompt message", () => {
    const errors = validateCommand({
      type: "prompt",
      sessionId: "test",
      message: "x".repeat(210_000),
    });
    assert(
      errors.some((e) => e.field === "message"),
      "Should reject long message"
    );
  });

  await test("validation: rejects session name with control chars", () => {
    const errors = validateCommand({
      type: "set_session_name",
      sessionId: "test",
      name: "bad\nname",
    });
    assert(
      errors.some((e) => e.field === "name"),
      "Should reject control chars"
    );
  });

  // Test: Reserved ID prefix
  await test("validation: rejects reserved ID prefix", () => {
    const errors = validateCommand({
      type: "list_sessions",
      id: "anon:123",
    });
    assert(
      errors.some((e) => e.field === "id" && e.message.includes("reserved prefix")),
      "Should reject reserved 'anon:' prefix"
    );
  });

  // Test: Valid custom ID (not using reserved prefix)
  await test("validation: accepts custom ID without reserved prefix", () => {
    const errors = validateCommand({
      type: "list_sessions",
      id: "my-custom-id-123",
    });
    assert.strictEqual(errors.length, 0, "Should have no errors");
  });

  // Test: Format validation errors
  await test("validation: formatValidationErrors works", () => {
    const formatted = formatValidationErrors([
      { field: "type", message: "Required" },
      { field: "sessionId", message: "Must be a string" },
    ]);
    assert(formatted.includes("type:"), "Should include field name");
    assert(formatted.includes("sessionId:"), "Should include field name");
  });

  // Test: Path validation for load_session
  await test("validation: rejects path traversal in load_session", () => {
    const errors = validateCommand({
      type: "load_session",
      sessionPath: "../../../etc/passwd",
    });
    assert(
      errors.some((e) => e.field === "sessionPath" && e.message.includes("dangerous")),
      "Should reject path traversal"
    );
  });

  await test("validation: rejects tilde expansion in load_session", () => {
    const errors = validateCommand({
      type: "load_session",
      sessionPath: "~/.ssh/id_rsa",
    });
    assert(
      errors.some((e) => e.field === "sessionPath" && e.message.includes("dangerous")),
      "Should reject tilde expansion"
    );
  });

  await test("validation: accepts valid absolute path in load_session", () => {
    const errors = validateCommand({
      type: "load_session",
      sessionPath: "/home/user/.pi/agent/sessions/2026-02-22/session.jsonl",
    });
    assert.strictEqual(errors.length, 0, "Should accept valid path");
  });

  await test("validation: rejects null byte in path", () => {
    const errors = validateCommand({
      type: "load_session",
      sessionPath: "/valid/path\u0000/../../../etc/passwd",
    });
    assert(
      errors.some((e) => e.field === "sessionPath" && e.message.includes("dangerous")),
      "Should reject null byte in path"
    );
  });

  await test("validation: rejects overly long path", () => {
    const errors = validateCommand({
      type: "load_session",
      sessionPath: "a".repeat(5000),
    });
    assert(
      errors.some((e) => e.field === "sessionPath" && e.message.includes("too long")),
      "Should reject overly long path"
    );
  });

  await test("validation: accepts valid navigate_tree command", () => {
    const errors = validateCommand({
      type: "navigate_tree",
      sessionId: "test",
      targetId: "msg-123",
      options: {
        summarize: true,
        customInstructions: "Keep concise",
        replaceInstructions: false,
        label: "summary",
      },
    });
    assert.strictEqual(errors.length, 0, "Should accept valid navigate_tree command");
  });

  await test("validation: rejects navigate_tree without targetId", () => {
    const errors = validateCommand({
      type: "navigate_tree",
      sessionId: "test",
    });
    assert(
      errors.some((e) => e.field === "targetId" && e.message.includes("Required")),
      "Should reject navigate_tree without targetId"
    );
  });

  await test("validation: rejects navigate_tree with invalid options", () => {
    const errors = validateCommand({
      type: "navigate_tree",
      sessionId: "test",
      targetId: "msg-123",
      options: {
        summarize: "yes",
        customInstructions: 42,
        replaceInstructions: "no",
        label: true,
      },
    });
    assert(
      errors.some((e) => e.field === "options.summarize"),
      "Should validate summarize"
    );
    assert(
      errors.some((e) => e.field === "options.customInstructions"),
      "Should validate customInstructions"
    );
    assert(
      errors.some((e) => e.field === "options.replaceInstructions"),
      "Should validate replaceInstructions"
    );
    assert(
      errors.some((e) => e.field === "options.label"),
      "Should validate label"
    );
  });

  await test("validation: accepts get_tree command", () => {
    const errors = validateCommand({ type: "get_tree", sessionId: "test" });
    assert.strictEqual(errors.length, 0, "Should accept valid get_tree command");
  });

  await test("validation: rejects get_tree without sessionId", () => {
    const errors = validateCommand({ type: "get_tree" });
    assert(
      errors.some((e) => e.field === "sessionId"),
      "Should require sessionId for get_tree"
    );
  });

  // Test: Path validation for switch_session_file
  await test("validation: rejects path traversal in switch_session_file", () => {
    const errors = validateCommand({
      type: "switch_session_file",
      sessionId: "test",
      sessionPath: "../../other-session",
    });
    assert(
      errors.some((e) => e.field === "sessionPath" && e.message.includes("dangerous")),
      "Should reject path traversal"
    );
  });
}

// =============================================================================
// SESSION PATH VALIDATION TESTS
// =============================================================================

import {
  validateSessionPath,
  validateSessionFileAccess,
  getDefaultAllowedSessionDirectories,
} from "./validation.js";

async function testSessionPathValidation() {
  console.log("\n=== Session Path Validation Tests ===\n");

  const home = process.env.HOME || "/home/user";

  // Test: Valid path under ~/.pi/agent/sessions/
  await test("sessionPath: accepts valid path under .pi/agent/sessions", () => {
    const error = validateSessionPath(`${home}/.pi/agent/sessions/2026-02-28/session.jsonl`);
    assert(error === null, `Should accept valid session path, got: ${error}`);
  });

  // Test: Valid project-local path
  await test("sessionPath: accepts valid project-local .pi/sessions path", () => {
    const error = validateSessionPath(join(process.cwd(), ".pi", "sessions", "session.jsonl"));
    assert(error === null, `Should accept project-local session path, got: ${error}`);
  });

  // Test: Reject relative path
  await test("sessionPath: rejects relative path", () => {
    const error = validateSessionPath("sessions/session.jsonl");
    assert(error?.includes("absolute"), `Should reject relative path, got: ${error}`);
  });

  // Test: Reject path traversal
  await test("sessionPath: rejects path traversal with ..", () => {
    const error = validateSessionPath(`${home}/.pi/agent/sessions/../../../etc/passwd`);
    assert(error?.includes("dangerous"), `Should reject path traversal, got: ${error}`);
  });

  // Test: Reject null byte injection
  await test("sessionPath: rejects null byte injection", () => {
    const error = validateSessionPath(`${home}/.pi/agent/sessions/session\0.jsonl`);
    assert(error?.includes("dangerous"), `Should reject null byte, got: ${error}`);
  });

  // Test: Reject non-session file extension
  await test("sessionPath: rejects non-session file extension", () => {
    const error = validateSessionPath(`${home}/.pi/agent/sessions/session.txt`);
    assert(error?.includes(".jsonl"), `Should reject non-session extension, got: ${error}`);
  });

  // Test: Reject path outside allowed directories
  await test("sessionPath: rejects path outside allowed directories", () => {
    const error = validateSessionPath(`/etc/sessions/session.jsonl`);
    assert(error?.includes("allowed"), `Should reject path outside allowed dirs, got: ${error}`);
  });

  // Test: Reject symlink escape from allowed directory
  await test("sessionPath: rejects symlink escape outside allowed directory", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-sessionpath-"));
    try {
      const allowed = join(base, "allowed");
      const outside = join(base, "outside");
      mkdirSync(allowed, { recursive: true });
      mkdirSync(outside, { recursive: true });

      const escapeLink = join(allowed, "escape");
      symlinkSync(outside, escapeLink, "dir");

      const candidate = join(escapeLink, "session.jsonl");
      const error = validateSessionPath(candidate, [allowed]);
      assert(error?.includes("allowed"), `Should reject symlink escape, got: ${error}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // Test: Accept .json extension
  await test("sessionPath: accepts .json extension", () => {
    const error = validateSessionPath(`${home}/.pi/agent/sessions/session.json`);
    assert(error === null, `Should accept .json extension, got: ${error}`);
  });

  await test("sessionPath: rejects outsider .pi/sessions path not rooted in allowed directories", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-sessionpath-outsider-"));
    try {
      const outsideDir = join(base, ".pi", "sessions");
      mkdirSync(outsideDir, { recursive: true });
      const sessionFile = join(outsideDir, "outsider.jsonl");
      writeFileSync(
        sessionFile,
        JSON.stringify({ type: "session", version: 3, cwd: "/tmp" }) + "\n"
      );

      const error = validateSessionPath(sessionFile);
      assert(error?.includes("allowed session directory"), `Unexpected error: ${error}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  await test("sessionPath: validateSessionFileAccess rejects non-session file header", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-sessionfile-header-"));
    const allowedDir = join(base, "allowed");
    mkdirSync(allowedDir, { recursive: true });
    const bogusPath = join(allowedDir, "not-session.jsonl");
    try {
      writeFileSync(bogusPath, JSON.stringify({ type: "not-session" }) + "\n");
      const error = validateSessionFileAccess(bogusPath, {
        allowedDirs: [allowedDir],
      });
      assert(error?.includes("existing session file"), `Unexpected error: ${error}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  await test("sessionPath: default allowed directories include current project .pi/sessions", () => {
    const allowedDirs = getDefaultAllowedSessionDirectories();
    assert(
      allowedDirs.some((dir) => dir.endsWith(join(".pi", "sessions"))),
      "Expected current project .pi/sessions to be in default allowed dirs"
    );
  });
}

// =============================================================================
// COMMAND ROUTER TESTS
// =============================================================================

import { getSupportedSessionCommands, routeSessionCommand } from "./command-router.js";

async function testCommandRouter() {
  console.log("\n=== Command Router Tests ===\n");

  // Test: Supported commands list
  await test("router: has expected commands", () => {
    const commands = getSupportedSessionCommands();
    assert(commands.includes("prompt"), "Should have prompt");
    assert(commands.includes("get_state"), "Should have get_state");
    assert(commands.includes("set_model"), "Should have set_model");
    assert(commands.includes("get_available_models"), "Should have get_available_models");
    assert(commands.includes("navigate_tree"), "Should have navigate_tree");
    assert(commands.length >= 25, `Should have at least 25 commands, got ${commands.length}`);
  });

  await test("router: get_tree returns normalized data", async () => {
    const iso = "2026-03-04T00:00:00.000Z";
    const tree: any[] = [
      {
        entry: {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: iso,
          message: { role: "user", content: "Show the repo status" },
        },
        label: undefined,
        children: [
          {
            entry: {
              type: "message",
              id: "assistant-1",
              parentId: "user-1",
              timestamp: iso,
              message: { role: "assistant", content: [{ type: "text", text: "Sure, running ls" }] },
            },
            label: "main",
            children: [
              {
                entry: {
                  type: "message",
                  id: "tool-1",
                  parentId: "assistant-1",
                  timestamp: iso,
                  message: {
                    role: "toolResult",
                    toolName: "bash",
                    content: [{ type: "text", text: "total 42" }],
                  },
                },
                label: undefined,
                children: [],
              },
            ],
          },
        ],
      },
    ];
    const fakeSession = {
      sessionManager: {
        getTree: () => tree,
        getLeafId: () => "tool-1",
      },
    } as any;

    const response = await routeSessionCommand(
      fakeSession,
      { type: "get_tree", sessionId: "session-x" },
      () => undefined
    );

    assert(response, "Should return response");
    assert.strictEqual(response!.success, true, "get_tree should succeed");
    const data = (response as any).data;
    assert.strictEqual(data.currentLeafId, "tool-1");
    assert(Array.isArray(data.nodes), "nodes should be an array");
    assert.strictEqual(data.nodes.length, 3, "Should include all tree nodes");

    const assistantNode = data.nodes.find((node: any) => node.entryId === "assistant-1");
    assert(assistantNode, "Assistant node should exist");
    assert.strictEqual(assistantNode.role, "assistant");
    assert.strictEqual(assistantNode.label, "main");

    const toolNode = data.nodes.find((node: any) => node.entryId === "tool-1");
    assert(toolNode, "Tool result node should exist");
    assert(toolNode.text.includes("total 42"), "Tool node should include preview text");

    const userNode = data.nodes.find((node: any) => node.entryId === "user-1");
    assert(userNode, "User node should exist");
    assert.strictEqual(userNode.role, "user");
  });

  await test("router: get_tree handles empty tree", async () => {
    const fakeSession = {
      sessionManager: {
        getTree: () => [],
        getLeafId: () => null,
      },
    } as any;

    const response = await routeSessionCommand(
      fakeSession,
      { type: "get_tree", sessionId: "session-empty" },
      () => undefined
    );

    assert(response, "Should return response for empty tree");
    assert.strictEqual(response!.success, true, "get_tree should succeed on empty tree");
    const data = (response as any).data;
    assert.strictEqual(data.currentLeafId, null, "Leaf ID should be null for empty tree");
    assert(Array.isArray(data.nodes), "nodes should be an array");
    assert.strictEqual(data.nodes.length, 0, "nodes should be empty");
  });

  await test("router: get_tree handles null tree", async () => {
    const fakeSession = {
      sessionManager: {
        getTree: () => null,
        getLeafId: () => null,
      },
    } as any;

    const response = await routeSessionCommand(
      fakeSession,
      { type: "get_tree", sessionId: "session-null" },
      () => undefined
    );

    assert(response, "Should return response for null tree");
    assert.strictEqual(response!.success, true, "get_tree should succeed on null tree");
    const data = (response as any).data;
    assert.strictEqual(data.nodes.length, 0, "nodes should be empty for null tree");
  });

  await test("router: get_tree handles malformed nodes gracefully", async () => {
    const tree: any[] = [
      {
        // Well-formed node
        entry: {
          type: "message",
          id: "good-1",
          parentId: null,
          message: { role: "user", content: "hi" },
        },
        children: [
          null, // Malformed: null child
          undefined, // Malformed: undefined child
          "not-an-object", // Malformed: string child
          {
            // Another well-formed node
            entry: {
              type: "message",
              id: "good-2",
              parentId: "good-1",
              message: { role: "assistant", content: "hello" },
            },
            children: [],
          },
        ],
      },
    ];
    const fakeSession = {
      sessionManager: {
        getTree: () => tree,
        getLeafId: () => "good-2",
      },
    } as any;

    const response = await routeSessionCommand(
      fakeSession,
      { type: "get_tree", sessionId: "session-malformed" },
      () => undefined
    );

    assert(response, "Should return response despite malformed nodes");
    assert.strictEqual(response!.success, true, "get_tree should succeed despite malformed nodes");
    const data = (response as any).data;
    // Should only include the 2 well-formed nodes
    assert.strictEqual(data.nodes.length, 2, "Should skip malformed nodes");
    assert(
      data.nodes.find((n: any) => n.entryId === "good-1"),
      "Should include first good node"
    );
    assert(
      data.nodes.find((n: any) => n.entryId === "good-2"),
      "Should include second good node"
    );
  });

  await test("router: switch_session_file rejects non-session files before upstream switch", async () => {
    const testDir = join(process.cwd(), ".pi", "sessions");
    mkdirSync(testDir, { recursive: true });
    const bogusPath = join(testDir, `router-invalid-${Date.now()}.jsonl`);
    let switchCalls = 0;

    try {
      writeFileSync(bogusPath, JSON.stringify({ type: "not-session" }) + "\n");

      const fakeSession = {
        switchSession: async () => {
          switchCalls++;
          return true;
        },
      } as any;

      const response = await routeSessionCommand(
        fakeSession,
        { type: "switch_session_file", sessionId: "session-x", sessionPath: bogusPath },
        () => undefined
      );

      assert(response, "Should return response");
      assert.strictEqual(response!.success, false, "Invalid session file should be rejected");
      assert(
        response!.error?.includes("existing session file"),
        `Unexpected error: ${response!.error}`
      );
      assert.strictEqual(switchCalls, 0, "Should not call upstream switchSession for invalid file");
    } finally {
      rmSync(bogusPath, { force: true });
    }
  });
}

// =============================================================================
// RESOURCE GOVERNOR TESTS
// =============================================================================

import { ResourceGovernor, DEFAULT_CONFIG } from "./resource-governor.js";
import { ExtensionUIManager } from "./extension-ui.js";

async function testResourceGovernor() {
  console.log("\n=== Resource Governor Tests ===\n");

  // Test: Default config values
  await test("governor: has default config", () => {
    const governor = new ResourceGovernor();
    const config = governor.getConfig();
    assert.strictEqual(config.maxSessions, 100, "Default maxSessions should be 100");
    assert.strictEqual(
      config.maxMessageSizeBytes,
      10 * 1024 * 1024,
      "Default maxMessageSizeBytes should be 10MB"
    );
    assert.strictEqual(
      config.maxCommandsPerMinute,
      100,
      "Default maxCommandsPerMinute should be 100"
    );
    assert.strictEqual(
      config.maxGlobalCommandsPerMinute,
      1000,
      "Default maxGlobalCommandsPerMinute should be 1000"
    );
  });

  // Test: Custom config
  await test("governor: accepts custom config", () => {
    const governor = new ResourceGovernor({ ...DEFAULT_CONFIG, maxSessions: 5 });
    assert.strictEqual(governor.getConfig().maxSessions, 5);
  });

  // Test: Atomic session reservation
  await test("governor: atomic session reservation", () => {
    const governor = new ResourceGovernor({ ...DEFAULT_CONFIG, maxSessions: 2 });
    assert.strictEqual(governor.tryReserveSessionSlot(), true, "First slot reserved");
    assert.strictEqual(governor.getSessionCount(), 1, "Count is 1");
    assert.strictEqual(governor.tryReserveSessionSlot(), true, "Second slot reserved");
    assert.strictEqual(governor.getSessionCount(), 2, "Count is 2");
    assert.strictEqual(governor.tryReserveSessionSlot(), false, "Third slot rejected");
    assert.strictEqual(governor.getSessionCount(), 2, "Count still 2");
  });

  // Test: Release session slot
  await test("governor: release session slot", () => {
    const governor = new ResourceGovernor({ ...DEFAULT_CONFIG, maxSessions: 1 });
    assert.strictEqual(governor.tryReserveSessionSlot(), true, "Slot reserved");
    governor.releaseSessionSlot();
    assert.strictEqual(governor.getSessionCount(), 0, "Count back to 0");
    assert.strictEqual(governor.tryReserveSessionSlot(), true, "Can reserve again");
  });

  // Test: Legacy session limit API (deprecated but still works)
  await test("governor: enforces session limit (legacy API)", () => {
    const governor = new ResourceGovernor({ ...DEFAULT_CONFIG, maxSessions: 2 });
    assert.strictEqual(
      governor.canCreateSession().allowed,
      true,
      "First session should be allowed"
    );
    governor.registerSession("s1");
    assert.strictEqual(
      governor.canCreateSession().allowed,
      true,
      "Second session should be allowed"
    );
    governor.registerSession("s2");
    const result = governor.canCreateSession();
    assert.strictEqual(result.allowed, false, "Third session should be rejected");
    assert(result.reason?.includes("Session limit"), "Should mention session limit");
  });

  // Test: Session count tracking via unregister
  await test("governor: tracks session count via unregister", () => {
    const governor = new ResourceGovernor();
    governor.registerSession("s1");
    assert.strictEqual(governor.getSessionCount(), 1);
    governor.registerSession("s2");
    assert.strictEqual(governor.getSessionCount(), 2);
    governor.unregisterSession("s1");
    assert.strictEqual(governor.getSessionCount(), 1);
  });

  // Test: Message size limit
  await test("governor: enforces message size limit", () => {
    const governor = new ResourceGovernor({ ...DEFAULT_CONFIG, maxMessageSizeBytes: 100 });
    assert.strictEqual(governor.canAcceptMessage(50).allowed, true, "50 bytes should be allowed");
    assert.strictEqual(governor.canAcceptMessage(100).allowed, true, "100 bytes should be allowed");
    const result = governor.canAcceptMessage(101);
    assert.strictEqual(result.allowed, false, "101 bytes should be rejected");
    assert(result.reason?.includes("exceeds limit"), "Should mention exceeds limit");
  });

  // Test: Invalid message sizes (negative, NaN, Infinity)
  await test("governor: rejects invalid message sizes", () => {
    const governor = new ResourceGovernor();

    const negResult = governor.canAcceptMessage(-1);
    assert.strictEqual(negResult.allowed, false, "Negative size should be rejected");
    assert(negResult.reason?.includes("Invalid"), "Should mention Invalid");

    const nanResult = governor.canAcceptMessage(NaN);
    assert.strictEqual(nanResult.allowed, false, "NaN should be rejected");

    const infResult = governor.canAcceptMessage(Infinity);
    assert.strictEqual(infResult.allowed, false, "Infinity should be rejected");
  });

  // Test: Per-session rate limiting
  await test("governor: enforces per-session rate limit", () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      maxCommandsPerMinute: 3,
      maxGlobalCommandsPerMinute: 100,
    });
    assert.strictEqual(governor.canExecuteCommand("s1").allowed, true, "1st command allowed");
    assert.strictEqual(governor.canExecuteCommand("s1").allowed, true, "2nd command allowed");
    assert.strictEqual(governor.canExecuteCommand("s1").allowed, true, "3rd command allowed");
    const result = governor.canExecuteCommand("s1");
    assert.strictEqual(result.allowed, false, "4th command should be rejected");
    assert(result.reason?.includes("Rate limit"), "Should mention rate limit");
  });

  // Test: Rate limiting is per-session
  await test("governor: rate limit is per session", () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      maxCommandsPerMinute: 2,
      maxGlobalCommandsPerMinute: 100,
    });
    assert.strictEqual(governor.canExecuteCommand("s1").allowed, true);
    assert.strictEqual(governor.canExecuteCommand("s1").allowed, true);
    assert.strictEqual(
      governor.canExecuteCommand("s1").allowed,
      false,
      "s1 should be rate limited"
    );
    assert.strictEqual(
      governor.canExecuteCommand("s2").allowed,
      true,
      "s2 should still be allowed"
    );
    assert.strictEqual(governor.canExecuteCommand("s2").allowed, true);
    assert.strictEqual(
      governor.canExecuteCommand("s2").allowed,
      false,
      "s2 should now be rate limited"
    );
  });

  // Test: Global rate limiting
  await test("governor: enforces global rate limit", () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      maxCommandsPerMinute: 100,
      maxGlobalCommandsPerMinute: 3,
    });
    assert.strictEqual(governor.canExecuteCommand("s1").allowed, true, "1st global command");
    assert.strictEqual(governor.canExecuteCommand("s2").allowed, true, "2nd global command");
    assert.strictEqual(governor.canExecuteCommand("s3").allowed, true, "3rd global command");
    const result = governor.canExecuteCommand("s4");
    assert.strictEqual(result.allowed, false, "4th command should hit global limit");
    assert(result.reason?.includes("Global rate limit"), "Should mention global rate limit");
  });

  // Test: Rate limit usage tracking
  await test("governor: tracks rate limit usage", () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      maxCommandsPerMinute: 5,
      maxGlobalCommandsPerMinute: 10,
    });
    governor.canExecuteCommand("s1");
    governor.canExecuteCommand("s1");
    governor.canExecuteCommand("s2");
    const usage = governor.getRateLimitUsage("s1");
    assert.strictEqual(usage.session, 2, "s1 should have 2 commands");
    assert.strictEqual(usage.global, 3, "global should have 3 commands");
  });

  // Test: Heartbeat tracking
  await test("governor: tracks heartbeats", () => {
    const governor = new ResourceGovernor();
    governor.registerSession("s1");
    const lastBeat = governor.getLastHeartbeat("s1");
    assert.strictEqual(typeof lastBeat, "number", "Should have heartbeat timestamp");
    governor.recordHeartbeat("s1");
    const newBeat = governor.getLastHeartbeat("s1");
    assert(newBeat! >= lastBeat!, "Heartbeat should be updated");
  });

  // Test: Zombie detection
  await test("governor: detects zombie sessions", async () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      zombieTimeoutMs: 100, // 100ms for testing
    });
    governor.registerSession("s1");
    assert.strictEqual(governor.getZombieSessions().length, 0, "Fresh session is not zombie");

    // Wait for zombie timeout
    await new Promise((resolve) => setTimeout(resolve, 150));

    const zombies = governor.getZombieSessions();
    assert.strictEqual(zombies.length, 1, "Should detect zombie");
    assert.strictEqual(zombies[0], "s1", "Zombie should be s1");
  });

  // Test: Metrics include global rate limit
  await test("governor: metrics include global rate limit", () => {
    const governor = new ResourceGovernor({ ...DEFAULT_CONFIG, maxGlobalCommandsPerMinute: 5 });
    governor.canExecuteCommand("s1");
    governor.canExecuteCommand("s1");
    const metrics = governor.getMetrics();
    assert.strictEqual(metrics.rateLimitUsage.globalCount, 2, "Should have 2 global commands");
    assert.strictEqual(metrics.rateLimitUsage.globalLimit, 5, "Should have limit 5");
    assert.strictEqual(
      typeof metrics.commandsRejected.globalRateLimit,
      "number",
      "Should track global rejections"
    );
  });

  // Test: Cleanup stale timestamps
  await test("governor: cleans up stale timestamps", () => {
    const governor = new ResourceGovernor();
    governor.canExecuteCommand("s1");
    governor.canExecuteCommand("s1");

    // Timestamps should exist
    const usageBefore = governor.getRateLimitUsage("s1");
    assert.strictEqual(usageBefore.session, 2, "Should have 2 timestamps");

    // Cleanup (won't remove recent ones)
    governor.cleanupStaleTimestamps();

    const usageAfter = governor.getRateLimitUsage("s1");
    assert.strictEqual(usageAfter.session, 2, "Recent timestamps still there");
  });

  // Test: Cleanup stale data for deleted sessions
  await test("governor: cleans up stale data", () => {
    const governor = new ResourceGovernor();
    governor.registerSession("s1");
    governor.registerSession("s2");
    governor.canExecuteCommand("s2");
    governor.unregisterSession("s2");

    // s2 is unregistered but may still have rate limit data
    // Clean up with only s1 active
    governor.cleanupStaleData(new Set(["s1"]));

    // s2's data should be cleaned
    assert.strictEqual(
      governor.getLastHeartbeat("s2"),
      undefined,
      "s2 heartbeat should be cleaned"
    );
  });

  // Test: Session ID validation
  await test("governor: validates session IDs", () => {
    const governor = new ResourceGovernor();

    // Valid IDs
    assert.strictEqual(governor.validateSessionId("test-1"), null);
    assert.strictEqual(governor.validateSessionId("my_session"), null);
    assert.strictEqual(governor.validateSessionId("session.1"), null);
    assert.strictEqual(governor.validateSessionId("a"), null);

    // Invalid IDs
    assert(governor.validateSessionId("")?.includes("non-empty"));
    assert(governor.validateSessionId("test session")?.includes("alphanumeric"));
    assert(governor.validateSessionId("test@session")?.includes("alphanumeric"));
    assert(governor.validateSessionId("../../../etc/passwd")?.includes("alphanumeric"));
    assert(governor.validateSessionId(null as any)?.includes("non-empty"));
  });

  // Test: CWD validation
  await test("governor: validates CWD paths", () => {
    const governor = new ResourceGovernor();
    const validDir = mkdtempSync(join(tmpdir(), "pi-governor-cwd-"));
    const filePath = join(validDir, "not-a-dir.txt");
    writeFileSync(filePath, "x");

    try {
      // Valid path (existing absolute directory)
      assert.strictEqual(governor.validateCwd(validDir), null);

      // Invalid paths
      assert(governor.validateCwd("relative/path")?.includes("absolute path"));
      assert(governor.validateCwd("~/home")?.includes("dangerous"));
      assert(governor.validateCwd(join(validDir, "missing"))?.includes("existing directory"));
      assert(governor.validateCwd(filePath)?.includes("existing directory"));
      assert(governor.validateCwd("")?.includes("non-empty"));
      assert(governor.validateCwd(null as any)?.includes("non-empty"));
    } finally {
      rmSync(validDir, { recursive: true, force: true });
    }
  });

  await test("governor: rejects overly long CWD", () => {
    const governor = new ResourceGovernor();
    const tooLong = "a".repeat(5000);
    assert(governor.validateCwd(tooLong)?.includes("too long"));
  });

  await test("governor: refundCommand restores counters with generation marker", () => {
    const governor = new ResourceGovernor({ ...DEFAULT_CONFIG, maxCommandsPerMinute: 2 });
    const result1 = governor.canExecuteCommand("s1");
    assert.strictEqual(result1.allowed, true);
    const gen1 = result1.generation;

    const result2 = governor.canExecuteCommand("s1");
    assert.strictEqual(result2.allowed, true);
    const gen2 = result2.generation;

    let metrics = governor.getMetrics();
    assert.strictEqual(metrics.totalCommandsExecuted, 2);

    // Refund using generation marker (removes correct entry even with same timestamp)
    governor.refundCommand("s1", gen1!);
    metrics = governor.getMetrics();
    assert.strictEqual(metrics.totalCommandsExecuted, 1);
    assert.strictEqual(governor.getRateLimitUsage("s1").session, 1);

    // Second refund with different generation
    governor.refundCommand("s1", gen2!);
    metrics = governor.getMetrics();
    assert.strictEqual(metrics.totalCommandsExecuted, 0);
    assert.strictEqual(governor.getRateLimitUsage("s1").session, 0);
  });

  await test("governor: refundCommand ignores unknown generation", () => {
    const governor = new ResourceGovernor({ ...DEFAULT_CONFIG, maxCommandsPerMinute: 2 });
    const result = governor.canExecuteCommand("s1");
    assert.strictEqual(result.allowed, true);

    // Try to refund with wrong generation
    governor.refundCommand("s1", 99999);
    const metrics = governor.getMetrics();
    assert.strictEqual(metrics.totalCommandsExecuted, 1); // Unchanged
  });

  // Test: Connection limits
  await test("governor: enforces connection limit", () => {
    const governor = new ResourceGovernor({ ...DEFAULT_CONFIG, maxConnections: 2 });

    assert.strictEqual(governor.canAcceptConnection().allowed, true);
    governor.registerConnection();
    assert.strictEqual(governor.getConnectionCount(), 1);

    assert.strictEqual(governor.canAcceptConnection().allowed, true);
    governor.registerConnection();
    assert.strictEqual(governor.getConnectionCount(), 2);

    const result = governor.canAcceptConnection();
    assert.strictEqual(result.allowed, false);
    assert(result.reason?.includes("Connection limit"));

    // Unregister
    governor.unregisterConnection();
    assert.strictEqual(governor.getConnectionCount(), 1);
  });

  await test("governor: reserves pending auth connections against connection limit", () => {
    const governor = new ResourceGovernor({ ...DEFAULT_CONFIG, maxConnections: 1 });

    const reserved = governor.tryReserveConnectionSlot();
    assert.strictEqual(reserved.allowed, true);
    assert.strictEqual(governor.getPendingConnectionCount(), 1);

    const blocked = governor.tryReserveConnectionSlot();
    assert.strictEqual(blocked.allowed, false);
    assert(blocked.reason?.includes("Connection limit"));

    governor.activateReservedConnection();
    assert.strictEqual(governor.getPendingConnectionCount(), 0);
    assert.strictEqual(governor.getConnectionCount(), 1);
  });

  // Test: Health check
  await test("governor: health check works", () => {
    const governor = new ResourceGovernor();

    const healthy = governor.isHealthy();
    assert.strictEqual(healthy.healthy, true);
    assert.deepStrictEqual(healthy.issues, []);
  });

  await test("governor: health_check does not inflate zombie detection metrics", async () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      zombieTimeoutMs: 50,
    });

    governor.registerSession("zombie-metric");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const before = governor.getMetrics().zombieSessionsDetected;
    governor.isHealthy();
    governor.isHealthy();
    const after = governor.getMetrics().zombieSessionsDetected;

    assert.strictEqual(after, before, "isHealthy() should not mutate detection metrics");
  });

  // Test: Zombie cleanup
  await test("governor: cleanupZombieSessions removes zombies", async () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      zombieTimeoutMs: 100,
    });

    governor.registerSession("zombie1");
    governor.registerSession("zombie2");

    // Wait for timeout
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Cleanup
    const cleaned = governor.cleanupZombieSessions();
    assert.strictEqual(cleaned.length, 2, "Should clean 2 zombies");
    assert(cleaned.includes("zombie1"));
    assert(cleaned.includes("zombie2"));

    // Verify cleaned
    assert.strictEqual(governor.getLastHeartbeat("zombie1"), undefined);
    assert.strictEqual(governor.getLastHeartbeat("zombie2"), undefined);
  });

  // Test: Metrics include connection count
  await test("governor: metrics include connection info", () => {
    const governor = new ResourceGovernor();
    governor.registerConnection();
    governor.registerConnection();

    const metrics = governor.getMetrics();
    assert.strictEqual(metrics.connectionCount, 2);
    assert.strictEqual(typeof metrics.commandsRejected.connectionLimit, "number");
    assert.strictEqual(typeof metrics.zombieSessionsCleaned, "number");
  });

  await test("governor: tracks double-unregister errors", () => {
    const governor = new ResourceGovernor();

    // Suppress expected error log for this intentional double-unregister test.
    const originalError = console.error;
    console.error = () => {};
    try {
      governor.registerConnection();
      governor.unregisterConnection();
      governor.unregisterConnection(); // intentional double-unregister
    } finally {
      console.error = originalError;
    }

    const metrics = governor.getMetrics();
    assert.strictEqual(metrics.doubleUnregisterErrors, 1);
  });
}

// =============================================================================
// EXTENSION UI TESTS
// =============================================================================

async function testExtensionUI() {
  console.log("\n=== Extension UI Tests ===\n");

  await test("extension-ui: honors per-request timeout", async () => {
    const ui = new ExtensionUIManager(() => {}, 500);
    const start = Date.now();

    const request = ui.createPendingRequest("s1", "input", { timeout: 50 });
    assert(request !== null, "createPendingRequest should not return null under normal conditions");

    // ExtensionUIManager uses unref() on timeout timers; keep event loop alive long
    // enough for the rejection to fire, otherwise Node may exit early in tests.
    const rejection = request.promise.then(
      () => {
        throw new Error("Expected request to time out");
      },
      (error) => error as Error
    );

    await new Promise((resolve) => setTimeout(resolve, 120));

    const error = await rejection;
    const elapsed = Date.now() - start;
    assert(elapsed < 500, `Expected timeout near request timeout, got ${elapsed}ms`);
    assert(error.message.includes("50ms"), "Error should report request-scoped timeout");
  });

  await test("extension-ui: rejects when pending limit reached", async () => {
    const ui = new ExtensionUIManager(() => {}, 500, 3); // max 3 pending

    // Create 3 requests (at limit) - catch rejections to avoid unhandled promise rejection
    const r1 = ui.createPendingRequest("s1", "input", {});
    const r2 = ui.createPendingRequest("s1", "input", {});
    const r3 = ui.createPendingRequest("s1", "input", {});

    assert(r1 !== null, "First request should succeed");
    assert(r2 !== null, "Second request should succeed");
    assert(r3 !== null, "Third request should succeed");

    // Catch promise rejections (they will be cancelled later)
    r1?.promise.catch(() => {});
    r2?.promise.catch(() => {});
    r3?.promise.catch(() => {});

    // Fourth should fail
    const r4 = ui.createPendingRequest("s1", "input", {});
    assert(r4 === null, "Fourth request should be rejected (at limit)");

    // Check stats
    const stats = ui.getStats();
    assert.strictEqual(stats.pendingCount, 3, "Should have 3 pending");
    assert.strictEqual(stats.maxPendingRequests, 3, "Max should be 3");
    assert.strictEqual(stats.rejectedCount, 1, "Should have 1 rejection");

    // Cleanup: cancel pending requests
    ui.cancelSessionRequests("s1");
  });

  await test("extension-ui: already-aborted signal does not create pending request", async () => {
    const events: Array<Record<string, unknown>> = [];
    const ui = new ExtensionUIManager((sessionId, event) => {
      events.push({ sessionId, ...(event as Record<string, unknown>) });
    });
    const ctx = createServerUIContext("s1", ui, (sessionId, event) => {
      events.push({ sessionId, ...(event as Record<string, unknown>) });
    });

    const controller = new AbortController();
    controller.abort();

    const result = await ctx.select("pick one", ["a", "b"], {
      signal: controller.signal,
      timeout: 50,
    });

    assert.strictEqual(result, undefined);
    assert.strictEqual(ui.getPendingCount(), 0, "Aborted request must not remain pending");
    assert.strictEqual(events.length, 0, "Aborted request must not broadcast UI events");
  });
}

// =============================================================================
// SESSION MANAGER TESTS
// =============================================================================

import { PiSessionManager } from "./session-manager.js";
import { PiServer, sendWithStdioBackpressure } from "./server.js";
import { DurableCommandJournal } from "./command-journal.js";
import { createServerUIContext } from "./server-ui-context.js";
import { SessionStore } from "./session-store.js";
import { MetricNames, type MetricEvent, type MetricsSink } from "./metrics-types.js";
import { WebSocket } from "ws";

class BufferedTestSink implements MetricsSink {
  private buffer: MetricEvent[] = [];
  private flushed: MetricEvent[] = [];

  record(event: MetricEvent): void {
    this.buffer.push(event);
  }

  async flush(): Promise<void> {
    this.flushed.push(...this.buffer);
    this.buffer = [];
  }

  hasFlushedMetric(name: string): boolean {
    return this.flushed.some((event) => event.name === name);
  }
}

async function testSessionManager() {
  console.log("\n=== Session Manager Tests ===\n");

  const manager = new PiSessionManager();

  // Test: Validation error returns proper response
  await test("session-manager: returns validation error", async () => {
    const response = await manager.executeCommand({ type: "get_state" } as any);
    assert.strictEqual(response.success, false, "Should fail");
    assert(response.error?.includes("Validation failed"), "Should mention validation");
  });

  // Test: Unknown command returns error
  await test("session-manager: returns error for unknown command", async () => {
    const response = await manager.executeCommand({
      type: "unknown_command",
      sessionId: "test",
    } as any);
    assert.strictEqual(response.success, false, "Should fail");
    assert(response.error?.includes("Unknown command type"), "Should mention unknown command type");
  });

  // Test: List sessions when empty
  await test("session-manager: lists empty sessions", async () => {
    const response = await manager.executeCommand({ type: "list_sessions" });
    assert.strictEqual(response.success, true, "Should succeed");
    assert.deepStrictEqual((response as any).data.sessions, [], "Should be empty array");
  });

  await test("session-manager: enforces dependsOn command dependencies", async () => {
    const first = await manager.executeCommand({ id: "dep-a", type: "list_sessions" });
    assert.strictEqual(first.success, true);

    const second = await manager.executeCommand({
      id: "dep-b",
      type: "list_sessions",
      dependsOn: ["dep-a"],
    } as any);
    assert.strictEqual(second.success, true, "Dependent command should succeed");
  });

  await test("session-manager: rejects unknown dependency", async () => {
    const response = await manager.executeCommand({
      id: "dep-missing",
      type: "list_sessions",
      dependsOn: ["missing-command"],
    } as any);

    assert.strictEqual(response.success, false);
    assert(response.error?.includes("Dependency 'missing-command'"));
  });

  await test("session-manager: replays idempotent commands", async () => {
    const first = await manager.executeCommand({
      id: "idem-1",
      type: "list_sessions",
      idempotencyKey: "same-key",
    } as any);
    const second = await manager.executeCommand({
      id: "idem-2",
      type: "list_sessions",
      idempotencyKey: "same-key",
    } as any);

    assert.strictEqual(first.success, true);
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.replayed, true, "Second response should come from replay cache");
  });

  await test("session-manager: concurrent idempotency retries collapse to one execution", async () => {
    const localManager = new PiSessionManager();
    const managerAny = localManager as any;
    let executions = 0;

    managerAny.executeCommandInternal = async (
      _command: any,
      id: string | undefined,
      commandType: string
    ) => {
      executions++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        id,
        type: "response",
        command: commandType,
        success: true,
      };
    };

    const [first, second] = await Promise.all([
      localManager.executeCommand({
        id: "idem-inflight-1",
        type: "list_sessions",
        idempotencyKey: "shared-inflight-key",
      } as any),
      localManager.executeCommand({
        id: "idem-inflight-2",
        type: "list_sessions",
        idempotencyKey: "shared-inflight-key",
      } as any),
    ]);

    assert.strictEqual(executions, 1, "Expected only one underlying execution");
    assert.strictEqual(first.success, true);
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.replayed, true, "Concurrent retry should replay in-flight result");
  });

  await test("session-manager: rejects conflicting duplicate command IDs", async () => {
    const first = await manager.executeCommand({ id: "dup-id", type: "list_sessions" } as any);
    assert.strictEqual(first.success, true);

    const second = await manager.executeCommand({ id: "dup-id", type: "health_check" } as any);
    assert.strictEqual(second.success, false, "Conflicting duplicate ID should fail");
    assert(second.error?.includes("Conflicting id 'dup-id'"));
  });

  await test("session-manager: rejects conflicting idempotency keys", async () => {
    const first = await manager.executeCommand({
      id: "idem-conflict-1",
      type: "list_sessions",
      idempotencyKey: "idem-conflict",
    } as any);
    assert.strictEqual(first.success, true);

    const second = await manager.executeCommand({
      id: "idem-conflict-2",
      type: "health_check",
      idempotencyKey: "idem-conflict",
    } as any);
    assert.strictEqual(second.success, false, "Conflicting idempotency key should fail");
    assert(second.error?.includes("Conflicting idempotencyKey 'idem-conflict'"));
  });

  await test("session-manager: strips stale response IDs when replaying without request id", async () => {
    const first = await manager.executeCommand({
      id: "idem-strip-1",
      type: "list_sessions",
      idempotencyKey: "idem-strip",
    } as any);
    assert.strictEqual(first.success, true);

    const second = await manager.executeCommand({
      type: "list_sessions",
      idempotencyKey: "idem-strip",
    } as any);
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.id, undefined, "Replay without request ID should not leak old ID");
  });

  await test("session-manager: fails fast for same-lane dependency inversion", async () => {
    const startedAt = Date.now();
    const [a, b] = await Promise.all([
      manager.executeCommand({
        id: "dep-invert-a",
        type: "list_sessions",
        dependsOn: ["dep-invert-b"],
      } as any),
      manager.executeCommand({ id: "dep-invert-b", type: "list_sessions" } as any),
    ]);

    const elapsed = Date.now() - startedAt;
    assert(elapsed < 5000, `Expected fast failure, got ${elapsed}ms`);
    assert.strictEqual(a.success, false, "Inverted dependency should fail");
    assert(a.error?.includes("same lane"));
    assert.strictEqual(b.success, true, "Independent command should still run");
  });

  await test("session-manager: dependency wait timeout is enforced", async () => {
    const localManager = new PiSessionManager(undefined, { dependencyWaitTimeoutMs: 40 });
    const never = new Promise<any>(() => {});

    // Simulate a dependency currently in-flight on a different lane.
    (localManager as any).replayStore.commandInFlightById.set("dep-stuck", {
      commandType: "get_state",
      laneKey: "session:other",
      fingerprint: "dep-stuck-fingerprint",
      promise: never,
    });

    const startedAt = Date.now();
    const response = await localManager.executeCommand({
      id: "dep-timeout",
      type: "list_sessions",
      dependsOn: ["dep-stuck"],
    } as any);

    const elapsed = Date.now() - startedAt;
    assert.strictEqual(response.success, false);
    assert(response.error?.includes("timed out"), `Unexpected error: ${response.error}`);
    assert(elapsed < 2000, `Dependency timeout should be fast in test, got ${elapsed}ms`);
  });

  await test("session-manager: idempotency cache expires by TTL", async () => {
    const localManager = new PiSessionManager(undefined, { idempotencyTtlMs: 40 });

    const first = await localManager.executeCommand({
      id: "idem-ttl-1",
      type: "list_sessions",
      idempotencyKey: "ttl-key",
    } as any);
    assert.strictEqual(first.success, true);

    await new Promise((resolve) => setTimeout(resolve, 70));

    const second = await localManager.executeCommand({
      id: "idem-ttl-2",
      type: "list_sessions",
      idempotencyKey: "ttl-key",
    } as any);

    assert.strictEqual(second.success, true);
    assert.notStrictEqual(second.replayed, true, "Expired idempotency entry should not replay");
  });

  await test("session-manager: replay after timeout returns SAME timeout response (ADR-0001)", async () => {
    // ADR-0001: Same command ID must ALWAYS return the same response.
    // If a command times out, the timeout response IS the final response.
    // Late completion does NOT update the stored outcome.

    const localManager = new PiSessionManager(undefined, {
      defaultCommandTimeoutMs: 10,
      shortCommandTimeoutMs: 10,
    });

    const managerAny = localManager as any;
    const originalExecuteInternal = managerAny.executeCommandInternal.bind(localManager);

    managerAny.executeCommandInternal = async (
      command: any,
      id: string | undefined,
      commandType: string
    ) => {
      if (commandType === "list_sessions") {
        await new Promise((resolve) => setTimeout(resolve, 40)); // Takes longer than timeout
        return {
          id,
          type: "response",
          command: "list_sessions",
          success: true,
          data: { sessions: [] },
        };
      }
      return originalExecuteInternal(command, id, commandType);
    };

    const first = await localManager.executeCommand({
      id: "timeout-replay",
      type: "list_sessions",
    });
    assert.strictEqual(first.success, false, "Initial caller should time out");
    assert(first.error?.includes("timed out"), `Expected timeout error, got: ${first.error}`);
    assert.strictEqual(first.timedOut, true, "Should have timedOut flag");

    await new Promise((resolve) => setTimeout(resolve, 70));

    // ADR-0001: Replay returns the SAME timeout response (idempotency invariant)
    const second = await localManager.executeCommand({
      id: "timeout-replay",
      type: "list_sessions",
    });
    assert.strictEqual(
      second.success,
      false,
      "Replay should return SAME timeout response (ADR-0001 invariant)"
    );
    assert(second.error?.includes("timed out"), "Replay should have timeout error");
    assert.strictEqual(second.replayed, true, "Second response should be replayed");
    assert.strictEqual(second.timedOut, true, "Replay should have timedOut flag");
  });

  await test("session-manager: failed commands consume rate limit (no refund)", async () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      maxCommandsPerMinute: 1,
      maxGlobalCommandsPerMinute: 100,
    });
    const testManager = new PiSessionManager(governor);

    const r1 = await testManager.executeCommand({ type: "get_state", sessionId: "missing" });
    assert.strictEqual(r1.success, false);
    assert(r1.error?.includes("not found"));

    // Second command should be rate limited (quota consumed, no refund on failure)
    // This prevents gaming the rate limit by sending commands that will fail
    const r2 = await testManager.executeCommand({ type: "get_state", sessionId: "missing" });
    assert.strictEqual(r2.success, false);
    assert(r2.error?.includes("Rate limit"), `Expected rate limit error, got: ${r2.error}`);
  });

  await test("session-manager: extension_ui_response secondary limiter refunds general rate limit", async () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      maxCommandsPerMinute: 2,
      maxGlobalCommandsPerMinute: 100,
      maxExtensionUIResponsePerMinute: 1,
    });
    const testManager = new PiSessionManager(governor);

    const first = await testManager.executeCommand({
      id: "ui-1",
      type: "extension_ui_response",
      sessionId: "ghost",
      requestId: "req-1",
      response: { method: "cancelled" },
    } as any);
    assert.strictEqual(first.success, false);
    assert(first.error?.includes("No pending UI request"));

    const second = await testManager.executeCommand({
      id: "ui-2",
      type: "extension_ui_response",
      sessionId: "ghost",
      requestId: "req-1",
      response: { method: "cancelled" },
    } as any);
    assert.strictEqual(second.success, false);
    assert(second.error?.includes("Extension UI response rate limit"));

    const third = await testManager.executeCommand({
      id: "state-1",
      type: "get_state",
      sessionId: "ghost",
    } as any);
    assert.strictEqual(third.success, false);
    assert(
      third.error?.includes("not found"),
      `General limiter should have been refunded, got: ${third.error}`
    );
  });

  await test("session-manager: replay operations are FREE (ADR-0001)", async () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      maxCommandsPerMinute: 1, // Only 1 NEW execution allowed
      maxGlobalCommandsPerMinute: 100,
    });
    const testManager = new PiSessionManager(governor);

    // First command with idempotency key (consumes the 1 quota)
    const r1 = await testManager.executeCommand({
      type: "list_sessions",
      idempotencyKey: "replay-test-key",
    } as any);
    assert.strictEqual(r1.success, true);

    // First replay should work (ADR-0001: replay is FREE)
    const r2 = await testManager.executeCommand({
      type: "list_sessions",
      idempotencyKey: "replay-test-key",
    } as any);
    assert.strictEqual(r2.success, true);
    assert.strictEqual(r2.replayed, true, "Should be replayed");

    // Second replay should ALSO work (replay is still FREE)
    const r3 = await testManager.executeCommand({
      type: "list_sessions",
      idempotencyKey: "replay-test-key",
    } as any);
    assert.strictEqual(r3.success, true);
    assert.strictEqual(r3.replayed, true, "Should be replayed");

    // But a NEW command should be rate limited (quota exhausted)
    const r4 = await testManager.executeCommand({
      type: "list_sessions",
      idempotencyKey: "different-key",
    } as any);
    assert.strictEqual(r4.success, false);
    assert(r4.error?.includes("Rate limit"), `Expected rate limit error, got: ${r4.error}`);
  });

  await test("session-manager: server busy rejection does not execute command side effects", async () => {
    const localManager = new PiSessionManager();
    (localManager as any).replayStore.maxInFlightCommands = 0;

    const response = await localManager.executeCommand({
      id: "busy-create",
      type: "create_session",
      sessionId: "busy-ghost",
    });

    assert.strictEqual(response.success, false, "Command should be rejected as busy");
    assert(response.error?.includes("Server busy"), `Unexpected error: ${response.error}`);
    assert.strictEqual(
      localManager.getSession("busy-ghost"),
      undefined,
      "Session must not be created on rejection"
    );
  });

  await test("session-manager: pre-execution busy rejection refunds general rate limit", async () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      maxCommandsPerMinute: 1,
      maxGlobalCommandsPerMinute: 100,
    });
    const localManager = new PiSessionManager(governor);
    (localManager as any).replayStore.maxInFlightCommands = 0;

    const busy = await localManager.executeCommand({
      id: "busy-refund",
      type: "list_sessions",
    } as any);
    assert.strictEqual(busy.success, false);
    assert(busy.error?.includes("Server busy"));

    const followUp = await localManager.executeCommand({
      type: "list_sessions",
    } as any);
    assert.strictEqual(followUp.success, true, `Expected refunded quota, got: ${followUp.error}`);
  });

  await test("session-manager: idempotency replay preserves timeout terminal outcome", async () => {
    const localManager = new PiSessionManager(undefined, {
      defaultCommandTimeoutMs: 10,
      shortCommandTimeoutMs: 10,
    });

    const managerAny = localManager as any;
    const originalExecuteInternal = managerAny.executeCommandInternal.bind(localManager);

    managerAny.executeCommandInternal = async (
      command: any,
      id: string | undefined,
      commandType: string
    ) => {
      if (commandType === "list_sessions") {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          id,
          type: "response",
          command: "list_sessions",
          success: true,
          data: { sessions: [] },
        };
      }
      return originalExecuteInternal(command, id, commandType);
    };

    const first = await localManager.executeCommand({
      id: "timeout-idem-1",
      type: "list_sessions",
      idempotencyKey: "timeout-idem-key",
    } as any);

    assert.strictEqual(first.success, false, "Initial request should time out");
    assert.strictEqual(first.timedOut, true, "Initial request should be marked timedOut");

    await new Promise((resolve) => setTimeout(resolve, 70));

    const second = await localManager.executeCommand({
      id: "timeout-idem-2",
      type: "list_sessions",
      idempotencyKey: "timeout-idem-key",
    } as any);

    assert.strictEqual(second.success, false, "Replay should preserve terminal timeout outcome");
    assert.strictEqual(second.timedOut, true, "Replay should stay timedOut");
    assert.strictEqual(second.replayed, true, "Replay should be served from cache");
  });

  await test("session-manager: durable journal rehydrates completed outcomes across restart", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-completed-"));

    try {
      const firstManager = new PiSessionManager(undefined, {
        durableJournal: { enabled: true, dataDir: journalDir },
      });
      await firstManager.initialize();

      const first = await firstManager.executeCommand({
        id: "durable-replay-1",
        type: "list_sessions",
      });
      assert.strictEqual(first.success, true);

      firstManager.disposeAllSessions();

      const secondManager = new PiSessionManager(undefined, {
        durableJournal: { enabled: true, dataDir: journalDir },
      });
      await secondManager.initialize();

      const second = await secondManager.executeCommand({
        id: "durable-replay-1",
        type: "list_sessions",
      });
      assert.strictEqual(second.success, true);
      assert.strictEqual(second.replayed, true, "Expected replay from durable recovery cache");

      secondManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: durable journal marks pre-crash in-flight commands as failed", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-inflight-"));

    try {
      const seededJournal = new DurableCommandJournal({
        enabled: true,
        dataDir: journalDir,
      });
      await seededJournal.initialize();

      seededJournal.appendLifecycle({
        phase: "command_accepted",
        commandId: "crash-inflight-1",
        commandType: "list_sessions",
        laneKey: "server",
        fingerprint: JSON.stringify({ type: "list_sessions" }),
        explicitId: true,
      });
      seededJournal.dispose();

      const recoveredManager = new PiSessionManager(undefined, {
        durableJournal: { enabled: true, dataDir: journalDir },
      });
      await recoveredManager.initialize();

      const replay = await recoveredManager.executeCommand({
        id: "crash-inflight-1",
        type: "list_sessions",
      });

      assert.strictEqual(replay.success, false, "Recovered in-flight command should be failed");
      assert.strictEqual(
        replay.replayed,
        true,
        "Recovered failure should replay deterministically"
      );
      assert.ok(replay.error?.includes("did not finish before previous shutdown"));

      recoveredManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: retention compaction drops synthetic in-flight artifacts", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-synth-inflight-drop-"));

    try {
      const seededJournal = new DurableCommandJournal({
        enabled: true,
        dataDir: journalDir,
      });
      await seededJournal.initialize();

      seededJournal.appendLifecycle({
        phase: "command_accepted",
        commandId: "anon:synthetic-inflight-1",
        commandType: "list_sessions",
        laneKey: "server",
        fingerprint: JSON.stringify({ type: "list_sessions" }),
        explicitId: false,
      });

      seededJournal.appendLifecycle({
        phase: "command_finished",
        commandId: "synthetic-drop-explicit-1",
        commandType: "list_sessions",
        laneKey: "server",
        fingerprint: JSON.stringify({ type: "list_sessions" }),
        explicitId: true,
        success: true,
        response: {
          id: "synthetic-drop-explicit-1",
          type: "response",
          command: "list_sessions",
          success: true,
          data: { sessions: [] },
        },
      });
      seededJournal.dispose();

      const recoveredManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          retention: { maxEntries: 10 },
        },
      });
      await recoveredManager.initialize();

      const historyResponse = await recoveredManager.executeCommand({
        type: "get_command_history",
        limit: 200,
      } as any);
      assert.strictEqual(historyResponse.success, true);

      const historyEntries = (historyResponse as any).data.entries as Array<{ commandId: string }>;
      assert.ok(
        historyEntries.some((entry) => entry.commandId === "synthetic-drop-explicit-1"),
        "Expected explicit terminal outcome to be retained"
      );
      assert.ok(
        !historyEntries.some((entry) => entry.commandId === "anon:synthetic-inflight-1"),
        "Synthetic in-flight marker must be dropped during compaction"
      );

      const replay = await recoveredManager.executeCommand({
        id: "synthetic-drop-explicit-1",
        type: "list_sessions",
      });
      assert.strictEqual(replay.success, true);
      assert.strictEqual(replay.replayed, true, "Explicit command should still replay");

      recoveredManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: durable recovery summary is deterministic across repeated boots", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-recovery-summary-"));

    try {
      const seededJournal = new DurableCommandJournal({
        enabled: true,
        dataDir: journalDir,
      });
      await seededJournal.initialize();

      seededJournal.appendLifecycle({
        phase: "command_accepted",
        commandId: "crash-inflight-repeat-1",
        commandType: "list_sessions",
        laneKey: "server",
        fingerprint: JSON.stringify({ type: "list_sessions" }),
        explicitId: true,
      });
      seededJournal.dispose();

      const firstBoot = new PiSessionManager(undefined, {
        durableJournal: { enabled: true, dataDir: journalDir },
      });
      await firstBoot.initialize();

      const firstSummary = await firstBoot.executeCommand({ type: "get_startup_recovery" });
      assert.strictEqual(firstSummary.success, true);
      const firstData = (firstSummary as any).data;
      assert.strictEqual(firstData.enabled, true);
      assert.strictEqual(firstData.initState, "ready");
      assert.strictEqual(firstData.recoveredInFlightFailures, 1);
      assert.strictEqual(firstData.recoveredOutcomes, 1);
      assert.ok(firstData.recoveredOutcomeIds.includes("crash-inflight-repeat-1"));

      firstBoot.disposeAllSessions();

      const secondBoot = new PiSessionManager(undefined, {
        durableJournal: { enabled: true, dataDir: journalDir },
      });
      await secondBoot.initialize();

      const secondSummary = await secondBoot.executeCommand({ type: "get_startup_recovery" });
      assert.strictEqual(secondSummary.success, true);
      const secondData = (secondSummary as any).data;
      assert.strictEqual(secondData.enabled, true);
      assert.strictEqual(secondData.initState, "ready");
      assert.strictEqual(secondData.recoveredInFlightFailures, 0);
      assert.strictEqual(secondData.recoveredOutcomes, 1);
      assert.ok(secondData.recoveredOutcomeIds.includes("crash-inflight-repeat-1"));

      const replay = await secondBoot.executeCommand({
        id: "crash-inflight-repeat-1",
        type: "list_sessions",
      });
      assert.strictEqual(replay.success, false);
      assert.strictEqual(replay.replayed, true);
      assert.ok(replay.error?.includes("did not finish before previous shutdown"));

      secondBoot.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: durable journal retention maxEntries keeps newest outcomes replayable", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-retention-max-entries-"));

    try {
      const firstManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          retention: { maxEntries: 1 },
        },
      });
      await firstManager.initialize();

      const firstOld = await firstManager.executeCommand({
        id: "retention-max-entries-old",
        type: "list_sessions",
      });
      assert.strictEqual(firstOld.success, true);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const firstNew = await firstManager.executeCommand({
        id: "retention-max-entries-new",
        type: "list_sessions",
      });
      assert.strictEqual(firstNew.success, true);

      firstManager.disposeAllSessions();

      const secondManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          retention: { maxEntries: 1 },
        },
      });
      await secondManager.initialize();

      const oldReplay = await secondManager.executeCommand({
        id: "retention-max-entries-old",
        type: "list_sessions",
      });
      assert.strictEqual(oldReplay.success, true);
      assert.notStrictEqual(oldReplay.replayed, true, "Older command should have been compacted");

      const newReplay = await secondManager.executeCommand({
        id: "retention-max-entries-new",
        type: "list_sessions",
      });
      assert.strictEqual(newReplay.success, true);
      assert.strictEqual(newReplay.replayed, true, "Newest command should remain replayable");

      secondManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: durable journal retention maxAgeMs drops stale outcomes", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-retention-max-age-"));

    try {
      const firstManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          retention: { maxAgeMs: 80 },
        },
      });
      await firstManager.initialize();

      const oldResponse = await firstManager.executeCommand({
        id: "retention-max-age-old",
        type: "list_sessions",
      });
      assert.strictEqual(oldResponse.success, true);

      await new Promise((resolve) => setTimeout(resolve, 120));

      const freshResponse = await firstManager.executeCommand({
        id: "retention-max-age-fresh",
        type: "list_sessions",
      });
      assert.strictEqual(freshResponse.success, true);

      firstManager.disposeAllSessions();

      const secondManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          retention: { maxAgeMs: 80 },
        },
      });
      await secondManager.initialize();

      const oldReplay = await secondManager.executeCommand({
        id: "retention-max-age-old",
        type: "list_sessions",
      });
      assert.strictEqual(oldReplay.success, true);
      assert.notStrictEqual(oldReplay.replayed, true, "Stale command should have been compacted");

      const freshReplay = await secondManager.executeCommand({
        id: "retention-max-age-fresh",
        type: "list_sessions",
      });
      assert.strictEqual(freshReplay.success, true);
      assert.strictEqual(freshReplay.replayed, true, "Fresh command should remain replayable");

      secondManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: retention maxBytes keeps in-flight recovery semantics", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-retention-max-bytes-"));

    try {
      const seededJournal = new DurableCommandJournal({
        enabled: true,
        dataDir: journalDir,
      });
      await seededJournal.initialize();

      const oversizedErrorA = "a".repeat(2000);
      seededJournal.appendLifecycle({
        phase: "command_finished",
        commandId: "retention-max-bytes-a",
        commandType: "list_sessions",
        laneKey: "server",
        fingerprint: JSON.stringify({ type: "list_sessions" }),
        explicitId: true,
        success: false,
        error: oversizedErrorA,
        response: {
          id: "retention-max-bytes-a",
          type: "response",
          command: "list_sessions",
          success: false,
          error: oversizedErrorA,
        },
      });

      const oversizedErrorB = "b".repeat(2000);
      seededJournal.appendLifecycle({
        phase: "command_finished",
        commandId: "retention-max-bytes-b",
        commandType: "list_sessions",
        laneKey: "server",
        fingerprint: JSON.stringify({ type: "list_sessions" }),
        explicitId: true,
        success: false,
        error: oversizedErrorB,
        response: {
          id: "retention-max-bytes-b",
          type: "response",
          command: "list_sessions",
          success: false,
          error: oversizedErrorB,
        },
      });

      seededJournal.appendLifecycle({
        phase: "command_accepted",
        commandId: "retention-max-bytes-inflight",
        commandType: "list_sessions",
        laneKey: "server",
        fingerprint: JSON.stringify({ type: "list_sessions" }),
        explicitId: true,
      });

      const journalRaw = readFileSync(seededJournal.getJournalPath(), "utf-8");
      const journalLines = journalRaw.split(/\r?\n/).filter((line) => line.trim().length > 0);

      let bytesA = 0;
      let bytesB = 0;
      let bytesInFlight = 0;
      for (const line of journalLines) {
        const parsed = JSON.parse(line) as { commandId?: string };
        const lineBytes = Buffer.byteLength(`${line}\n`, "utf-8");
        if (parsed.commandId === "retention-max-bytes-a") {
          bytesA = lineBytes;
        } else if (parsed.commandId === "retention-max-bytes-b") {
          bytesB = lineBytes;
        } else if (parsed.commandId === "retention-max-bytes-inflight") {
          bytesInFlight = lineBytes;
        }
      }

      assert.ok(
        bytesA > 0 && bytesB > 0 && bytesInFlight > 0,
        "Expected seeded journal line sizes"
      );

      // Keep newest terminal outcome + in-flight marker, force oldest terminal drop.
      const maxBytes = bytesInFlight + bytesB + Math.max(1, Math.floor(bytesA / 2));
      seededJournal.dispose();

      const recoveredManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          retention: { maxBytes },
        },
      });
      await recoveredManager.initialize();

      const oldReplay = await recoveredManager.executeCommand({
        id: "retention-max-bytes-a",
        type: "list_sessions",
      });
      assert.strictEqual(oldReplay.success, true);
      assert.notStrictEqual(oldReplay.replayed, true, "Oldest oversized outcome should be dropped");

      const newReplay = await recoveredManager.executeCommand({
        id: "retention-max-bytes-b",
        type: "list_sessions",
      });
      assert.strictEqual(newReplay.success, false);
      assert.strictEqual(newReplay.replayed, true, "Newest oversized outcome should remain");

      const inflightReplay = await recoveredManager.executeCommand({
        id: "retention-max-bytes-inflight",
        type: "list_sessions",
      });
      assert.strictEqual(inflightReplay.success, false);
      assert.strictEqual(
        inflightReplay.replayed,
        true,
        "In-flight recovery must remain deterministic"
      );
      assert.ok(inflightReplay.error?.includes("did not finish before previous shutdown"));

      recoveredManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: rate-limited commands do not emit command_accepted", async () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      maxCommandsPerMinute: 1,
      maxGlobalCommandsPerMinute: 100,
    });
    const localManager = new PiSessionManager(governor);

    const events: any[] = [];
    const subscriber = {
      send: (data: string) => {
        events.push(JSON.parse(data));
      },
      subscribedSessions: new Set<string>(),
    };
    localManager.addSubscriber(subscriber);

    const first = await localManager.executeCommand({
      id: "rl-lifecycle-1",
      type: "list_sessions",
    } as any);
    assert.strictEqual(first.success, true);

    const second = await localManager.executeCommand({
      id: "rl-lifecycle-2",
      type: "list_sessions",
    } as any);
    assert.strictEqual(second.success, false);
    assert(second.error?.includes("Rate limit"));

    const accepted = events.find(
      (e) => e.type === "command_accepted" && e.data?.commandId === "rl-lifecycle-2"
    );
    const started = events.find(
      (e) => e.type === "command_started" && e.data?.commandId === "rl-lifecycle-2"
    );
    const finished = events.find(
      (e) => e.type === "command_finished" && e.data?.commandId === "rl-lifecycle-2"
    );

    assert.strictEqual(accepted, undefined, "Rejected command must not emit command_accepted");
    assert.strictEqual(started, undefined, "Rejected command must not emit command_started");
    assert.ok(finished, "Expected command_finished event for rate-limited command");
    assert.strictEqual(finished.data.success, false, "Finished event should report failure");

    localManager.removeSubscriber(subscriber);
  });

  await test("session-manager: delete_session uses control-plane rate limit bucket", async () => {
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      maxCommandsPerMinute: 1,
      maxGlobalCommandsPerMinute: 100,
    });
    const localManager = new PiSessionManager(governor);

    const fakeSession = {
      bindExtensions: async () => {},
      subscribe: () => () => {},
      dispose: () => {
        (fakeSession as any).disposed = true;
      },
      sessionFile: join(tmpdir(), `control-delete-${Date.now()}.jsonl`),
      model: { id: "fake-model" },
      thinkingLevel: "medium",
      isStreaming: false,
      messages: [],
      sessionName: "control-delete",
    };
    (localManager as any).createAgentSessionWithSanitizedNpmEnv = async () => ({
      session: fakeSession,
    });

    await localManager.createSession("control-delete");

    const first = await localManager.executeCommand({
      id: "control-delete-state-1",
      type: "get_state",
      sessionId: "control-delete",
    } as any);
    assert.strictEqual(first.success, true);

    const second = await localManager.executeCommand({
      id: "control-delete-state-2",
      type: "get_state",
      sessionId: "control-delete",
    } as any);
    assert.strictEqual(second.success, false);
    assert(second.error?.includes("Rate limit"));

    const deleted = await localManager.executeCommand({
      id: "control-delete-now",
      type: "delete_session",
      sessionId: "control-delete",
    } as any);
    assert.strictEqual(deleted.success, true, deleted.error);
    assert.strictEqual(localManager.getSession("control-delete"), undefined);
  });

  await test("session-manager: create_session ignores npm_config_prefix leakage", async () => {
    const previousPrefix = process.env.npm_config_prefix;
    process.env.npm_config_prefix = process.cwd();

    const localManager = new PiSessionManager();
    const diagnostics: Array<{ message: string; context?: Record<string, unknown> }> = [];
    localManager.setDebugLogger((message, context) => {
      diagnostics.push({ message, context });
    });

    try {
      for (const sessionId of ["prefix-sanitize", "prefix-sanitize-2"]) {
        const created = await localManager.executeCommand({
          type: "create_session",
          sessionId,
        });

        assert.strictEqual(
          created.success,
          true,
          `Session creation should succeed with sanitized npm prefix: ${created.error}`
        );

        await localManager.executeCommand({
          type: "delete_session",
          sessionId,
        });
      }

      assert.strictEqual(
        diagnostics.length,
        1,
        "Expected npm prefix sanitization diagnostic to be emitted once"
      );
      assert.strictEqual(
        diagnostics[0]?.message,
        "Sanitized npm prefix env for AgentSession creation"
      );
      assert.deepStrictEqual((diagnostics[0]?.context as any)?.keys, ["npm_config_prefix"]);
    } finally {
      if (previousPrefix === undefined) {
        delete process.env.npm_config_prefix;
      } else {
        process.env.npm_config_prefix = previousPrefix;
      }
    }
  });

  await test("session-manager: load_session initializes version at 0", async () => {
    const localManager = new PiSessionManager();
    const sessionsDir = join(process.cwd(), ".pi", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionPath = join(sessionsDir, `load-version-${Date.now()}.jsonl`);

    try {
      writeFileSync(
        sessionPath,
        JSON.stringify({
          type: "session",
          version: 3,
          id: `load-version-${Date.now()}`,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }) + "\n"
      );

      const loadedAutoId = await localManager.executeCommand({
        type: "load_session",
        sessionPath,
      } as any);
      assert.strictEqual(loadedAutoId.success, true);
      assert.strictEqual(
        loadedAutoId.sessionVersion,
        0,
        "Auto-id load_session should start at version 0"
      );

      await localManager.executeCommand({
        type: "delete_session",
        sessionId: (loadedAutoId as any).data.sessionId,
      });

      const loadedExplicitId = await localManager.executeCommand({
        type: "load_session",
        sessionId: "load-explicit",
        sessionPath,
      } as any);
      assert.strictEqual(loadedExplicitId.success, true);
      assert.strictEqual(
        loadedExplicitId.sessionVersion,
        0,
        "Explicit-id load_session should start at version 0"
      );

      await localManager.executeCommand({ type: "delete_session", sessionId: "load-explicit" });
    } finally {
      rmSync(sessionPath, { force: true });
    }
  });

  await test("session-manager: load_session persists source session cwd", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pi-load-session-cwd-"));
    const localManager = new PiSessionManager();
    (localManager as any).sessionStore = new SessionStore({
      dataDir,
      sessionsDir: dataDir,
      serverVersion: "test",
    });

    const sourceCwd = join(tmpdir(), "pi-loaded-session-origin");
    const sessionPath = join(process.cwd(), ".pi", "sessions", `load-cwd-${Date.now()}.jsonl`);
    mkdirSync(join(process.cwd(), ".pi", "sessions"), { recursive: true });
    writeFileSync(
      sessionPath,
      JSON.stringify({ type: "session", version: 3, cwd: sourceCwd }) + "\n"
    );

    const fakeSession = {
      bindExtensions: async () => {},
      subscribe: () => () => {},
      dispose: () => {},
      switchSession: async () => true,
      sessionFile: sessionPath,
      model: { id: "fake-model" },
      thinkingLevel: "medium",
      isStreaming: false,
      messages: [],
      sessionName: "loaded-session",
    };
    (localManager as any).createAgentSessionWithSanitizedNpmEnv = async () => ({
      session: fakeSession,
    });

    try {
      const response = await localManager.loadSession("persisted-cwd", sessionPath);
      assert.strictEqual(response.sessionId, "persisted-cwd");

      const metadataPath = join(dataDir, "sessions-metadata.json");
      const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
      assert.strictEqual(metadata.sessions[0]?.cwd, sourceCwd);
    } finally {
      rmSync(sessionPath, { force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: load_session uses source session cwd for runtime creation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pi-load-runtime-cwd-"));
    const localManager = new PiSessionManager();
    (localManager as any).sessionStore = new SessionStore({
      dataDir,
      sessionsDir: dataDir,
      serverVersion: "test",
    });

    const sourceCwd = join(tmpdir(), "pi-loaded-runtime-origin");
    const sessionPath = join(
      process.cwd(),
      ".pi",
      "sessions",
      `load-runtime-cwd-${Date.now()}.jsonl`
    );
    mkdirSync(join(process.cwd(), ".pi", "sessions"), { recursive: true });
    writeFileSync(
      sessionPath,
      JSON.stringify({ type: "session", version: 3, cwd: sourceCwd }) + "\n"
    );

    let capturedCwd: string | undefined;
    const fakeSession = {
      bindExtensions: async () => {},
      subscribe: () => () => {},
      dispose: () => {},
      switchSession: async () => true,
      sessionFile: sessionPath,
      model: { id: "fake-model" },
      thinkingLevel: "medium",
      isStreaming: false,
      messages: [],
      sessionName: "runtime-cwd",
    };
    (localManager as any).createAgentSessionWithSanitizedNpmEnv = async (options: {
      cwd?: string;
    }) => {
      capturedCwd = options.cwd;
      return { session: fakeSession };
    };

    try {
      const response = await localManager.loadSession("runtime-cwd", sessionPath);
      assert.strictEqual(response.sessionId, "runtime-cwd");
      assert.strictEqual(capturedCwd, sourceCwd);
    } finally {
      rmSync(sessionPath, { force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: set_session_name waits for durable mutation instead of timing out", async () => {
    const localManager = new PiSessionManager(undefined, {
      shortCommandTimeoutMs: 50,
      defaultCommandTimeoutMs: 50,
    });
    const managerAny = localManager as any;

    const fakeSession = {
      dispose: () => {},
      sessionFile: "/tmp/rename-timeout.jsonl",
      model: undefined,
      thinkingLevel: "medium",
      isStreaming: false,
      messages: [],
      sessionName: "before",
      setSessionName(name: string) {
        fakeSession.sessionName = name;
      },
    };

    let enteredUpdateName!: () => void;
    const updateNameEntered = new Promise<void>((resolve) => {
      enteredUpdateName = resolve;
    });
    let releaseUpdateName!: () => void;
    const updateNameBlocked = new Promise<void>((resolve) => {
      releaseUpdateName = resolve;
    });

    managerAny.sessions.set("rename-safe", fakeSession);
    managerAny.sessionCreatedAt.set("rename-safe", new Date());
    managerAny.versionStore.initialize("rename-safe");
    managerAny.governor.tryReserveSessionSlot();
    managerAny.governor.recordHeartbeat("rename-safe");
    managerAny.sessionStore.updateName = async () => {
      enteredUpdateName();
      await updateNameBlocked;
      return true;
    };

    let settled = false;
    const responsePromise = localManager
      .executeCommand({
        id: "rename-safe-1",
        type: "set_session_name",
        sessionId: "rename-safe",
        name: "after",
      } as any)
      .then((response) => {
        settled = true;
        return response;
      });

    await updateNameEntered;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(settled, false, "Response must not settle before durable rename finishes");

    releaseUpdateName();
    const response = await responsePromise;

    assert.strictEqual(response.success, true);
    assert.strictEqual(response.timedOut, undefined);
    assert.strictEqual(fakeSession.sessionName, "after");
    localManager.disposeAllSessions();
  });

  await test("session-manager: delete_session waits for durable mutation instead of timing out", async () => {
    const localManager = new PiSessionManager(undefined, {
      shortCommandTimeoutMs: 50,
      defaultCommandTimeoutMs: 50,
    });
    const managerAny = localManager as any;

    const fakeSession = {
      dispose: () => {
        (fakeSession as any).disposed = true;
      },
      sessionFile: "/tmp/delete-timeout.jsonl",
      model: undefined,
      thinkingLevel: "medium",
      isStreaming: false,
      messages: [],
      sessionName: "delete-me",
    };

    let enteredDelete!: () => void;
    const deleteEntered = new Promise<void>((resolve) => {
      enteredDelete = resolve;
    });
    let releaseDelete!: () => void;
    const deleteBlocked = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    managerAny.sessions.set("delete-safe", fakeSession);
    managerAny.sessionCreatedAt.set("delete-safe", new Date());
    managerAny.versionStore.initialize("delete-safe");
    managerAny.governor.tryReserveSessionSlot();
    managerAny.governor.recordHeartbeat("delete-safe");
    managerAny.sessionStore.delete = async () => {
      enteredDelete();
      await deleteBlocked;
      return true;
    };

    let settled = false;
    const responsePromise = localManager
      .executeCommand({
        id: "delete-safe-1",
        type: "delete_session",
        sessionId: "delete-safe",
      } as any)
      .then((response) => {
        settled = true;
        return response;
      });

    await deleteEntered;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(settled, false, "Response must not settle before durable delete finishes");

    releaseDelete();
    const response = await responsePromise;

    assert.strictEqual(response.success, true);
    assert.strictEqual(response.timedOut, undefined);
    assert.strictEqual(localManager.getSession("delete-safe"), undefined);
    assert.strictEqual((fakeSession as any).disposed, true);
    assert.strictEqual(localManager.getGovernor().getSessionCount(), 0);
    localManager.disposeAllSessions();
  });

  await test("session-manager: create_session rolls back runtime state on metadata failure", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pi-create-rollback-"));
    const localManager = new PiSessionManager();
    (localManager as any).sessionStore = new SessionStore({
      dataDir,
      sessionsDir: dataDir,
      serverVersion: "test",
    });

    const fakeSession = {
      bindExtensions: async () => {},
      subscribe: () => () => {},
      dispose: () => {
        (fakeSession as any).disposed = true;
      },
      sessionFile: join(dataDir, "ghost.jsonl"),
      model: { id: "fake-model" },
      thinkingLevel: "medium",
      isStreaming: false,
      messages: [],
      sessionName: "ghost",
    };
    (localManager as any).createAgentSessionWithSanitizedNpmEnv = async () => ({
      session: fakeSession,
    });
    (localManager as any).sessionStore.save = async () => {
      throw new Error("disk full");
    };

    await assert.rejects(() => localManager.createSession("rollback-create"), /disk full/);
    assert.strictEqual(localManager.getSession("rollback-create"), undefined);
    assert.strictEqual(localManager.getGovernor().getSessionCount(), 0);
    assert.strictEqual((fakeSession as any).disposed, true);

    rmSync(dataDir, { recursive: true, force: true });
  });

  await test("session-manager: load_session rolls back runtime state on metadata failure", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pi-load-rollback-"));
    const localManager = new PiSessionManager();
    (localManager as any).sessionStore = new SessionStore({
      dataDir,
      sessionsDir: dataDir,
      serverVersion: "test",
    });

    const sessionPath = join(process.cwd(), ".pi", "sessions", `load-rollback-${Date.now()}.jsonl`);
    mkdirSync(join(process.cwd(), ".pi", "sessions"), { recursive: true });
    writeFileSync(
      sessionPath,
      JSON.stringify({ type: "session", version: 3, cwd: process.cwd() }) + "\n"
    );

    const fakeSession = {
      bindExtensions: async () => {},
      subscribe: () => () => {},
      dispose: () => {
        (fakeSession as any).disposed = true;
      },
      switchSession: async () => true,
      sessionFile: sessionPath,
      model: { id: "fake-model" },
      thinkingLevel: "medium",
      isStreaming: false,
      messages: [],
      sessionName: "ghost-load",
    };
    (localManager as any).createAgentSessionWithSanitizedNpmEnv = async () => ({
      session: fakeSession,
    });
    (localManager as any).sessionStore.save = async () => {
      throw new Error("disk full");
    };

    try {
      await assert.rejects(
        () => localManager.loadSession("rollback-load", sessionPath),
        /disk full/
      );
      assert.strictEqual(localManager.getSession("rollback-load"), undefined);
      assert.strictEqual(localManager.getGovernor().getSessionCount(), 0);
      assert.strictEqual((fakeSession as any).disposed, true);
    } finally {
      rmSync(sessionPath, { force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: delete_session preserves runtime state when metadata delete fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pi-delete-rollback-"));
    const localManager = new PiSessionManager();
    (localManager as any).sessionStore = new SessionStore({
      dataDir,
      sessionsDir: dataDir,
      serverVersion: "test",
    });

    const fakeSession = {
      bindExtensions: async () => {},
      subscribe: () => () => {},
      dispose: () => {
        (fakeSession as any).disposed = true;
      },
      sessionFile: join(dataDir, "persist.jsonl"),
      model: { id: "fake-model" },
      thinkingLevel: "medium",
      isStreaming: false,
      messages: [],
      sessionName: "delete-rollback",
    };
    (localManager as any).createAgentSessionWithSanitizedNpmEnv = async () => ({
      session: fakeSession,
    });

    await localManager.createSession("delete-rollback");
    (localManager as any).sessionStore.delete = async () => {
      throw new Error("disk full");
    };

    await assert.rejects(() => localManager.deleteSession("delete-rollback"), /disk full/);
    assert.ok(
      localManager.getSession("delete-rollback"),
      "Session should remain live after failure"
    );
    assert.strictEqual((fakeSession as any).disposed, undefined);

    rmSync(dataDir, { recursive: true, force: true });
  });

  await test("session-manager: delete_session surfaces runtime cleanup failures", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pi-delete-runtime-fail-"));
    const localManager = new PiSessionManager();
    (localManager as any).sessionStore = new SessionStore({
      dataDir,
      sessionsDir: dataDir,
      serverVersion: "test",
    });

    const fakeSession = {
      bindExtensions: async () => {},
      subscribe: () => () => {
        throw new Error("unsubscribe boom");
      },
      dispose: () => {
        throw new Error("dispose boom");
      },
      sessionFile: join(dataDir, "persist.jsonl"),
      model: { id: "fake-model" },
      thinkingLevel: "medium",
      isStreaming: false,
      messages: [],
      sessionName: "delete-runtime-fail",
    };
    (localManager as any).createAgentSessionWithSanitizedNpmEnv = async () => ({
      session: fakeSession,
    });

    await localManager.createSession("delete-runtime-fail");

    const response = await localManager.executeCommand({
      id: "delete-runtime-fail-1",
      type: "delete_session",
      sessionId: "delete-runtime-fail",
    } as any);

    assert.strictEqual(response.success, false);
    assert.ok(response.error?.includes("runtime cleanup failed"));
    assert.strictEqual(localManager.getSession("delete-runtime-fail"), undefined);

    rmSync(dataDir, { recursive: true, force: true });
  });

  await test("session-manager: load_session rejects outsider project-local session paths", async () => {
    const localManager = new PiSessionManager();
    const base = mkdtempSync(join(tmpdir(), "pi-load-outsider-"));
    const outsiderDir = join(base, ".pi", "sessions");
    const outsiderPath = join(outsiderDir, "outsider.jsonl");

    try {
      mkdirSync(outsiderDir, { recursive: true });
      writeFileSync(
        outsiderPath,
        JSON.stringify({ type: "session", version: 3, cwd: "/tmp" }) + "\n"
      );

      const response = await localManager.executeCommand({
        type: "load_session",
        sessionId: "outsider-load",
        sessionPath: outsiderPath,
      } as any);
      assert.strictEqual(response.success, false);
      assert(
        response.error?.includes("allowed session directory"),
        `Unexpected error: ${response.error}`
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // Test: Create and delete session (integration test)
  await test("session-manager: creates and deletes session", async () => {
    const createResponse = await manager.executeCommand({
      type: "create_session",
      sessionId: "test-session-1",
    });
    assert.strictEqual(createResponse.success, true, "Create should succeed");
    assert.strictEqual((createResponse as any).data.sessionId, "test-session-1");

    // List should now have one session
    const listResponse = await manager.executeCommand({ type: "list_sessions" });
    assert.strictEqual((listResponse as any).data.sessions.length, 1, "Should have 1 session");

    // Delete the session
    const deleteResponse = await manager.executeCommand({
      type: "delete_session",
      sessionId: "test-session-1",
    });
    assert.strictEqual(deleteResponse.success, true, "Delete should succeed");

    // List should be empty again
    const listResponse2 = await manager.executeCommand({ type: "list_sessions" });
    assert.strictEqual((listResponse2 as any).data.sessions.length, 0, "Should be empty again");
  });

  // Test: Cannot create duplicate session
  await test("session-manager: rejects duplicate session", async () => {
    await manager.executeCommand({ type: "create_session", sessionId: "dup-test" });
    const response = await manager.executeCommand({
      type: "create_session",
      sessionId: "dup-test",
    });
    assert.strictEqual(response.success, false, "Should fail");
    assert(response.error?.includes("already exists"), "Should mention already exists");

    // Cleanup
    await manager.executeCommand({ type: "delete_session", sessionId: "dup-test" });
  });

  // Test: Cannot delete non-existent session
  await test("session-manager: rejects deleting non-existent session", async () => {
    const response = await manager.executeCommand({
      type: "delete_session",
      sessionId: "nonexistent",
    });
    assert.strictEqual(response.success, false, "Should fail");
    assert(response.error?.includes("not found"), "Should mention not found");
  });

  // Test: Get state of created session
  await test("session-manager: gets session state", async () => {
    await manager.executeCommand({ type: "create_session", sessionId: "state-test" });
    const response = await manager.executeCommand({ type: "get_state", sessionId: "state-test" });
    assert.strictEqual(response.success, true, "Should succeed");
    assert.strictEqual((response as any).data.sessionId, "state-test");
    assert.strictEqual(typeof (response as any).data.createdAt, "string");

    // Cleanup
    await manager.executeCommand({ type: "delete_session", sessionId: "state-test" });
  });

  // Test: Switch session
  await test("session-manager: switches session", async () => {
    const created = await manager.executeCommand({
      type: "create_session",
      sessionId: "switch-test",
    });
    assert.strictEqual(created.success, true, "Create should succeed");
    assert.strictEqual(created.sessionVersion, 0, "New session should start at version 0");

    const response = await manager.executeCommand({
      type: "switch_session",
      sessionId: "switch-test",
    });
    assert.strictEqual(response.success, true, "Should succeed");
    assert.strictEqual((response as any).data.sessionInfo.sessionId, "switch-test");
    assert.strictEqual(
      response.sessionVersion,
      0,
      "switch_session should not mutate session version"
    );

    // Cleanup
    await manager.executeCommand({ type: "delete_session", sessionId: "switch-test" });
  });

  // Test: Session limit enforcement through manager
  await test("session-manager: enforces session limit via governor", async () => {
    // Create a manager with a low session limit
    const governor = new ResourceGovernor({
      ...DEFAULT_CONFIG,
      maxSessions: 2,
    });
    const limitedManager = new PiSessionManager(governor);

    // Create two sessions - should succeed
    const r1 = await limitedManager.executeCommand({ type: "create_session", sessionId: "lim1" });
    assert.strictEqual(r1.success, true, "First session should succeed");
    const r2 = await limitedManager.executeCommand({ type: "create_session", sessionId: "lim2" });
    assert.strictEqual(r2.success, true, "Second session should succeed");

    // Third session should fail
    const r3 = await limitedManager.executeCommand({ type: "create_session", sessionId: "lim3" });
    assert.strictEqual(r3.success, false, "Third session should fail");
    assert(r3.error?.includes("Session limit"), "Should mention session limit");

    // Cleanup
    await limitedManager.executeCommand({ type: "delete_session", sessionId: "lim1" });
    await limitedManager.executeCommand({ type: "delete_session", sessionId: "lim2" });
  });

  // Test: Graceful shutdown rejects new commands
  await test("session-manager: rejects commands during shutdown", async () => {
    const manager = new PiSessionManager();

    // Create a session first
    await manager.executeCommand({ type: "create_session", sessionId: "shutdown-test" });

    // Initiate shutdown (don't await yet)
    const shutdownPromise = manager.initiateShutdown(1000);

    // Try to execute a command - should be rejected
    const response = await manager.executeCommand({ type: "list_sessions" });
    assert.strictEqual(response.success, false, "Should reject during shutdown");
    assert(response.error?.includes("shutting down"), "Should mention shutting down");

    // Wait for shutdown to complete
    await shutdownPromise;

    // Cleanup
    // Note: session is still there, just can't execute commands
  });

  // Test: Shutdown with no in-flight commands
  await test("session-manager: shutdown with no in-flight commands", async () => {
    const manager = new PiSessionManager();

    const result = await manager.initiateShutdown(1000);
    assert.strictEqual(result.drained, 0, "Should drain 0 commands");
    assert.strictEqual(result.timedOut, false, "Should not timeout");
  });

  await test("session-manager: sanitizes invalid shutdown timeout", async () => {
    const localManager = new PiSessionManager();
    const result = await localManager.initiateShutdown(-1 as any);
    assert.strictEqual(result.timedOut, false);
  });

  // Test: In-flight count tracking
  await test("session-manager: tracks in-flight commands", async () => {
    const manager = new PiSessionManager();

    // Create a session
    await manager.executeCommand({ type: "create_session", sessionId: "inflight-test" });

    // After command completes, in-flight should be 0
    assert.strictEqual(manager.getInFlightCount(), 0, "No in-flight after completion");

    // Cleanup
    await manager.executeCommand({ type: "delete_session", sessionId: "inflight-test" });
  });

  // Test: Idempotent shutdown
  await test("session-manager: shutdown is idempotent", async () => {
    const manager = new PiSessionManager();

    // First shutdown
    const result1 = await manager.initiateShutdown(1000);
    assert.strictEqual(result1.timedOut, false, "First shutdown should succeed");

    // Second shutdown should return immediately without error
    const result2 = await manager.initiateShutdown(1000);
    assert.strictEqual(result2.timedOut, false, "Second shutdown should be idempotent");
    assert.strictEqual(result2.drained, 0, "No commands to drain on second call");
  });

  // Test: isInShutdown reflects state
  await test("session-manager: isInShutdown reflects state", async () => {
    const manager = new PiSessionManager();

    assert.strictEqual(manager.isInShutdown(), false, "Not in shutdown initially");

    await manager.initiateShutdown(1000);

    assert.strictEqual(manager.isInShutdown(), true, "In shutdown after initiateShutdown");
  });

  // Test: get_metrics includes store stats (ADR-0001 observability)
  await test("session-manager: get_metrics includes store stats", async () => {
    const manager = new PiSessionManager();

    // Create a session
    await manager.executeCommand({ type: "create_session", sessionId: "metrics-test" });

    // Execute a command
    await manager.executeCommand({ type: "list_sessions" });

    // Get metrics
    const response = await manager.executeCommand({ type: "get_metrics" });
    assert.strictEqual(response.success, true, "get_metrics should succeed");

    const data = (response as any).data;
    assert.ok(data.stores, "Should have stores object");
    assert.ok(data.stores.replay, "Should have replay store stats");
    assert.ok(data.stores.version, "Should have version store stats");
    assert.ok(data.stores.execution, "Should have execution store stats");

    // Verify replay store has expected fields
    assert.strictEqual(typeof data.stores.replay.inFlightCount, "number");
    assert.strictEqual(typeof data.stores.replay.outcomeCount, "number");
    assert.strictEqual(typeof data.stores.replay.idempotencyCacheSize, "number");
    assert.strictEqual(typeof data.stores.replay.maxInFlightCommands, "number");
    assert.strictEqual(typeof data.stores.replay.maxCommandOutcomes, "number");

    // Verify version store has session
    assert.strictEqual(data.stores.version.sessionCount, 1, "Should have 1 session");

    // Verify journal retention/compaction stats shape
    assert.ok(data.stores.journal, "Should have journal store stats");
    assert.ok(
      ["best_effort", "fail_closed"].includes(data.stores.journal.appendFailurePolicy),
      "Expected appendFailurePolicy enum"
    );
    assert.strictEqual(typeof data.stores.journal.redaction.beforePersistHookEnabled, "boolean");
    assert.strictEqual(typeof data.stores.journal.redaction.beforeExportHookEnabled, "boolean");
    assert.strictEqual(typeof data.stores.journal.retention.enabled, "boolean");
    assert.strictEqual(typeof data.stores.journal.compaction.runs, "number");
    assert.strictEqual(typeof data.stores.journal.compaction.droppedEntries, "number");

    // Cleanup
    await manager.executeCommand({ type: "delete_session", sessionId: "metrics-test" });
  });

  await test("session-manager: get_startup_recovery returns defaults when journal disabled", async () => {
    const response = await manager.executeCommand({ type: "get_startup_recovery" });
    assert.strictEqual(response.success, true, "get_startup_recovery should succeed");

    const data = (response as any).data;
    assert.strictEqual(data.enabled, false, "Journal should be disabled by default");
    assert.strictEqual(data.initState, "disabled", "Disabled journal should report disabled state");
    assert.strictEqual(typeof data.initialized, "boolean", "Should include initialized flag");
    assert.ok(typeof data.journalPath === "string", "Should include journalPath");
    assert.ok(Array.isArray(data.recoveredOutcomeIds), "Should include recoveredOutcomeIds");
    assert.ok(Array.isArray(data.recoveredInFlight), "Should include recoveredInFlight list");
    assert.strictEqual(data.recoveredOutcomeIdsTruncated, false);
    assert.strictEqual(data.recoveredInFlightTruncated, false);
    assert.strictEqual(data.maxItemsReturned, 100);
  });

  await test("session-manager: startup_recovery_summary event payload matches command", async () => {
    const response = await manager.executeCommand({ type: "get_startup_recovery" });
    assert.strictEqual(response.success, true);

    const event = manager.getStartupRecoverySummaryEvent();
    assert.strictEqual(event.type, "startup_recovery_summary");
    assert.deepStrictEqual(event.data, (response as any).data);
  });

  await test("session-manager: startup_recovery_summary supports redacted and sensitive variants", async () => {
    const response = await manager.executeCommand({ type: "get_startup_recovery" });
    assert.strictEqual(response.success, true);

    const redacted = manager.getStartupRecoverySummaryEvent({ includeSensitiveData: false });
    assert.strictEqual(redacted.type, "startup_recovery_summary");
    assert.strictEqual(redacted.data.journalPath, "[redacted]");
    assert.deepStrictEqual(redacted.data.recoveredOutcomeIds, []);
    assert.deepStrictEqual(redacted.data.recoveredInFlight, []);

    const sensitive = manager.getStartupRecoverySummaryEvent({ includeSensitiveData: true });
    assert.deepStrictEqual(sensitive.data, (response as any).data);
  });

  await test("session-manager: get_startup_recovery participates in duplicate-id conflict detection", async () => {
    const first = await manager.executeCommand({
      id: "startup-dup-id",
      type: "get_startup_recovery",
    } as any);
    assert.strictEqual(first.success, true);

    const second = await manager.executeCommand({
      id: "startup-dup-id",
      type: "health_check",
    } as any);
    assert.strictEqual(second.success, false);
    assert.ok(second.error?.includes("Conflicting id 'startup-dup-id'"));
  });

  await test("session-manager: get_startup_recovery emits lifecycle events", async () => {
    const localManager = new PiSessionManager();
    const events: any[] = [];

    const subscriber = {
      send: (data: string) => {
        events.push(JSON.parse(data));
      },
      subscribedSessions: new Set<string>(),
    };

    localManager.addSubscriber(subscriber);
    try {
      const response = await localManager.executeCommand({
        id: "startup-life-1",
        type: "get_startup_recovery",
      } as any);

      assert.strictEqual(response.success, true);
      const accepted = events.find(
        (e) => e.type === "command_accepted" && e.data?.commandId === "startup-life-1"
      );
      const started = events.find(
        (e) => e.type === "command_started" && e.data?.commandId === "startup-life-1"
      );
      const finished = events.find(
        (e) => e.type === "command_finished" && e.data?.commandId === "startup-life-1"
      );

      assert.ok(accepted, "Expected command_accepted event");
      assert.ok(started, "Expected command_started event");
      assert.ok(finished, "Expected command_finished event");
      assert.strictEqual(finished.data.success, true);
    } finally {
      localManager.removeSubscriber(subscriber);
    }
  });

  await test("session-manager: get_command_history returns empty result when journal disabled", async () => {
    const response = await manager.executeCommand({ type: "get_command_history" } as any);
    assert.strictEqual(response.success, true, "get_command_history should succeed");

    const data = (response as any).data;
    assert.strictEqual(data.enabled, false);
    assert.strictEqual(data.initState, "disabled");
    assert.ok(Array.isArray(data.entries));
    assert.strictEqual(data.entries.length, 0);
    assert.strictEqual(data.truncated, false);
  });

  await test("session-manager: get_command_history applies filters and bounded limit", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-history-query-"));

    try {
      const seededJournal = new DurableCommandJournal({
        enabled: true,
        dataDir: journalDir,
      });
      await seededJournal.initialize();

      seededJournal.appendLifecycle({
        phase: "command_accepted",
        commandId: "history-cmd-a",
        commandType: "prompt",
        laneKey: "session:history-s1",
        fingerprint: JSON.stringify({ type: "prompt", sessionId: "history-s1", message: "hi" }),
        explicitId: true,
        sessionId: "history-s1",
      });
      seededJournal.appendLifecycle({
        phase: "command_started",
        commandId: "history-cmd-a",
        commandType: "prompt",
        laneKey: "session:history-s1",
        fingerprint: JSON.stringify({ type: "prompt", sessionId: "history-s1", message: "hi" }),
        explicitId: true,
        sessionId: "history-s1",
      });
      seededJournal.appendLifecycle({
        phase: "command_finished",
        commandId: "history-cmd-a",
        commandType: "prompt",
        laneKey: "session:history-s1",
        fingerprint: JSON.stringify({ type: "prompt", sessionId: "history-s1", message: "hi" }),
        explicitId: true,
        sessionId: "history-s1",
        success: true,
        response: {
          id: "history-cmd-a",
          type: "response",
          command: "prompt",
          success: true,
        },
      });

      seededJournal.appendLifecycle({
        phase: "command_finished",
        commandId: "history-cmd-b",
        commandType: "list_sessions",
        laneKey: "server",
        fingerprint: JSON.stringify({ type: "list_sessions" }),
        explicitId: true,
        sessionId: "history-s2",
        success: true,
        response: {
          id: "history-cmd-b",
          type: "response",
          command: "list_sessions",
          success: true,
          data: { sessions: [] },
        },
      });
      seededJournal.dispose();

      const localManager = new PiSessionManager(undefined, {
        durableJournal: { enabled: true, dataDir: journalDir },
      });
      await localManager.initialize();

      const filtered = await localManager.executeCommand({
        type: "get_command_history",
        sessionIdFilter: "history-s1",
        limit: 2,
      } as any);
      assert.strictEqual(filtered.success, true);

      const filteredData = (filtered as any).data;
      assert.strictEqual(filteredData.enabled, true);
      assert.strictEqual(filteredData.returned, 2);
      assert.strictEqual(filteredData.truncated, true);
      assert.strictEqual(filteredData.maxItemsReturned, 2);
      assert.strictEqual(filteredData.filters.sessionIdFilter, "history-s1");
      assert.ok(
        filteredData.entries.every((entry: any) => entry.sessionId === "history-s1"),
        "All entries should match session filter"
      );

      const byCommandId = await localManager.executeCommand({
        type: "get_command_history",
        commandId: "history-cmd-b",
      } as any);
      assert.strictEqual(byCommandId.success, true);
      const byCommandIdData = (byCommandId as any).data;
      assert.strictEqual(byCommandIdData.returned, 1);
      assert.strictEqual(byCommandIdData.entries[0]?.commandId, "history-cmd-b");
      assert.strictEqual(byCommandIdData.truncated, false);
      assert.ok(
        String(filteredData.entries[0]?.fingerprint || "").startsWith("v2:sha256:"),
        "History should export hashed fingerprints"
      );
      assert.strictEqual(
        JSON.stringify(filteredData.entries).includes('"message":"hi"'),
        false,
        "History fingerprints must not leak raw command payloads"
      );

      localManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: get_command_history returns newest entries first", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-history-newest-"));

    try {
      const journal = new DurableCommandJournal({ enabled: true, dataDir: journalDir });
      await journal.initialize();

      for (const commandId of ["history-1", "history-2", "history-3"]) {
        journal.appendLifecycle({
          phase: "command_finished",
          commandId,
          commandType: "list_sessions",
          laneKey: "server",
          fingerprint: JSON.stringify({ type: "list_sessions", commandId }),
          explicitId: true,
          sessionId: "history-session",
          success: true,
          response: {
            id: commandId,
            type: "response",
            command: "list_sessions",
            success: true,
            data: { sessions: [] },
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      journal.dispose();

      const localManager = new PiSessionManager(undefined, {
        durableJournal: { enabled: true, dataDir: journalDir },
      });
      await localManager.initialize();

      const historyResponse = await localManager.executeCommand({
        type: "get_command_history",
        sessionIdFilter: "history-session",
        limit: 2,
      } as any);
      assert.strictEqual(historyResponse.success, true);

      const data = (historyResponse as any).data;
      assert.deepStrictEqual(
        data.entries.map((entry: any) => entry.commandId),
        ["history-3", "history-2"]
      );
      assert.strictEqual(data.truncated, true);

      localManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: get_command_history enforces scan budget", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-history-budget-"));

    try {
      const localManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          historyScanMaxEntries: 5,
        },
      });
      await localManager.initialize();

      for (let i = 0; i < 4; i++) {
        const response = await localManager.executeCommand({
          id: `history-budget-${i}`,
          type: "list_sessions",
        } as any);
        assert.strictEqual(response.success, true);
      }

      const historyResponse = await localManager.executeCommand({
        type: "get_command_history",
        limit: 200,
      } as any);
      assert.strictEqual(historyResponse.success, true);

      const data = (historyResponse as any).data;
      assert.strictEqual(data.truncated, true, "Scan budget should force truncation");
      assert.ok(data.returned <= 5, `Expected <=5 entries from scan budget, got ${data.returned}`);

      localManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: best_effort append failures do not fail command flow", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-append-best-effort-"));
    const originalConsoleError = console.error;

    try {
      console.error = () => {};

      const localManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          appendFailurePolicy: "best_effort",
          redaction: {
            beforePersist: () => {
              throw new Error("injected-append-failure-best-effort");
            },
          },
        },
      });
      await localManager.initialize();

      const command = await localManager.executeCommand({
        id: "append-best-effort-1",
        type: "list_sessions",
      } as any);
      assert.strictEqual(command.success, true, "best_effort should keep command execution open");

      const history = await localManager.executeCommand({
        type: "get_command_history",
        commandId: "append-best-effort-1",
      } as any);
      assert.strictEqual(history.success, true);
      assert.strictEqual(
        (history as any).data.returned,
        0,
        "Failed appends should not persist history"
      );

      const metrics = await localManager.executeCommand({ type: "get_metrics" } as any);
      assert.strictEqual(metrics.success, true);
      assert.strictEqual((metrics as any).data.stores.journal.appendFailurePolicy, "best_effort");
      assert.strictEqual(
        (metrics as any).data.stores.journal.redaction.beforePersistHookEnabled,
        true
      );

      localManager.disposeAllSessions();
    } finally {
      console.error = originalConsoleError;
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: fail_closed append failures fail command flow but keep observability", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-append-fail-closed-"));
    const originalConsoleError = console.error;

    try {
      console.error = () => {};

      const localManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          appendFailurePolicy: "fail_closed",
          redaction: {
            beforePersist: () => {
              throw new Error("injected-append-failure-fail-closed");
            },
          },
        },
      });
      await localManager.initialize();

      const command = await localManager.executeCommand({
        id: "append-fail-closed-1",
        type: "list_sessions",
      } as any);
      assert.strictEqual(command.success, false, "fail_closed should reject on append failures");
      assert.ok(
        command.error?.includes("command_accepted") || command.error?.includes("command_finished"),
        `Expected phase marker in error, got: ${command.error}`
      );
      assert.ok(command.error?.includes("injected-append-failure-fail-closed"));

      const followUp = await localManager.executeCommand({
        id: "append-fail-closed-2",
        type: "list_sessions",
      } as any);
      assert.strictEqual(followUp.success, false, "Subsequent commands should fail closed");
      assert.ok(followUp.error?.includes("Durable journal append failed"));

      const recovery = await localManager.executeCommand({ type: "get_startup_recovery" } as any);
      assert.strictEqual(recovery.success, true, "Startup recovery must remain available");
      assert.strictEqual((recovery as any).data.initState, "failed");

      const history = await localManager.executeCommand({
        type: "get_command_history",
        limit: 10,
      } as any);
      assert.strictEqual(history.success, true, "History should remain available for diagnostics");

      localManager.disposeAllSessions();
    } finally {
      console.error = originalConsoleError;
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: fail_closed command_finished append failure downgrades terminal response", async () => {
    const journalDir = mkdtempSync(
      join(tmpdir(), "pi-server-journal-append-fail-closed-finished-")
    );
    const originalConsoleError = console.error;

    try {
      console.error = () => {};

      const localManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          appendFailurePolicy: "fail_closed",
          redaction: {
            beforePersist: (entry) => {
              if (entry.phase === "command_finished") {
                throw new Error("injected-append-failure-command-finished");
              }
              return entry;
            },
          },
        },
      });
      await localManager.initialize();

      const response = await localManager.executeCommand({
        id: "append-fail-closed-finished-1",
        type: "list_sessions",
      } as any);

      assert.strictEqual(response.success, false, "Fail-closed should downgrade terminal response");
      assert.ok(response.error?.includes("command_finished"));
      assert.ok(response.error?.includes("injected-append-failure-command-finished"));

      const replayStore = (localManager as any).replayStore;
      const stored = replayStore.getCommandOutcome("append-fail-closed-finished-1");
      assert.ok(stored, "Expected stored terminal outcome");
      assert.strictEqual(stored.success, false, "Stored outcome must match downgraded failure");
      assert.strictEqual(
        stored.response.success,
        false,
        "Stored response must match downgraded failure"
      );
      assert.ok(stored.error?.includes("command_finished"));

      localManager.disposeAllSessions();
    } finally {
      console.error = originalConsoleError;
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: fail_closed append failures remain deterministic across restart", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-fail-closed-restart-"));
    const originalConsoleError = console.error;

    try {
      console.error = () => {};

      const firstBoot = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          appendFailurePolicy: "fail_closed",
          redaction: {
            beforePersist: (entry) => {
              if (entry.phase === "command_finished") {
                throw new Error("restart-finished-failure");
              }
              return entry;
            },
          },
        },
      });
      await firstBoot.initialize();

      const firstResponse = await firstBoot.executeCommand({
        id: "fail-closed-restart-1",
        type: "list_sessions",
      } as any);
      assert.strictEqual(firstResponse.success, false);
      firstBoot.disposeAllSessions();

      const secondBoot = new PiSessionManager(undefined, {
        durableJournal: { enabled: true, dataDir: journalDir },
      });
      await secondBoot.initialize();

      const secondResponse = await secondBoot.executeCommand({
        id: "fail-closed-restart-1",
        type: "list_sessions",
      } as any);
      assert.strictEqual(secondResponse.success, false);
      assert.strictEqual(secondResponse.replayed, true);
      assert.strictEqual(secondResponse.error, firstResponse.error);

      secondBoot.disposeAllSessions();
    } finally {
      console.error = originalConsoleError;
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("command-journal: beforePersist rejects replay-critical response removal", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-redaction-invariant-"));

    try {
      const journal = new DurableCommandJournal({
        enabled: true,
        dataDir: journalDir,
        redaction: {
          beforePersist: (entry) => {
            if (entry.phase === "command_finished") {
              return {
                ...entry,
                response: undefined,
              };
            }
            return entry;
          },
        },
      });
      await journal.initialize();

      assert.throws(
        () =>
          journal.appendLifecycle({
            phase: "command_finished",
            commandId: "redaction-invariant-cmd-1",
            commandType: "list_sessions",
            laneKey: "server",
            fingerprint: JSON.stringify({ type: "list_sessions" }),
            explicitId: true,
            success: true,
            response: {
              id: "redaction-invariant-cmd-1",
              type: "response",
              command: "list_sessions",
              success: true,
              data: { sessions: [] },
            },
          }),
        /replay-critical response/
      );

      journal.dispose();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: durable journal redaction hooks apply to persistence and export", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-redaction-hooks-"));

    try {
      const localManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          redaction: {
            beforePersist: (entry) => ({
              ...entry,
              idempotencyKey: entry.idempotencyKey ? "[redacted-idempotency]" : undefined,
            }),
            beforeExport: (result) => ({
              ...result,
              journalPath: "[redacted-journal-path]",
              entries: result.entries.map((entry) => ({
                ...entry,
                fingerprint: "[redacted-fingerprint]",
              })),
            }),
          },
        },
      });
      await localManager.initialize();

      const executed = await localManager.executeCommand({
        id: "redaction-hook-cmd-1",
        type: "list_sessions",
        idempotencyKey: "secret-idempotency-token",
      } as any);
      assert.strictEqual(executed.success, true);

      const history = await localManager.executeCommand({
        type: "get_command_history",
        commandId: "redaction-hook-cmd-1",
        limit: 20,
      } as any);
      assert.strictEqual(history.success, true);

      const data = (history as any).data;
      assert.strictEqual(data.journalPath, "[redacted-journal-path]");
      assert.ok(data.returned > 0, "Expected history entries for command");

      const finishedEntry = data.entries.find((entry: any) => entry.phase === "command_finished");
      assert.ok(finishedEntry, "Expected command_finished history entry");
      assert.strictEqual(finishedEntry.idempotencyKey, "[redacted-idempotency]");
      assert.strictEqual(finishedEntry.fingerprint, "[redacted-fingerprint]");

      localManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: startup recovery tolerates truncated journal tail", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-chaos-recovery-"));

    try {
      const journalPath = join(journalDir, "command-journal.jsonl");
      const now = Date.now();
      const lines = [
        JSON.stringify({
          schemaVersion: 1,
          kind: "command_lifecycle",
          phase: "command_finished",
          recordedAt: now - 2000,
          serverVersion: "test",
          commandId: "chaos-finished-1",
          commandType: "list_sessions",
          laneKey: "server",
          laneSequence: 1,
          fingerprint: JSON.stringify({ type: "list_sessions" }),
          explicitId: true,
          success: true,
          response: {
            id: "chaos-finished-1",
            type: "response",
            command: "list_sessions",
            success: true,
            data: { sessions: [] },
          },
        }),
        JSON.stringify({
          schemaVersion: 1,
          kind: "command_lifecycle",
          phase: "command_accepted",
          recordedAt: now - 1000,
          serverVersion: "test",
          commandId: "chaos-inflight-1",
          commandType: "list_sessions",
          laneKey: "server",
          laneSequence: 2,
          fingerprint: JSON.stringify({ type: "list_sessions" }),
          explicitId: true,
        }),
        '{"schemaVersion":1,"kind":"command_lifecycle","phase":"command_started"',
      ];
      writeFileSync(journalPath, `${lines.join("\n")}\n`, "utf-8");

      const localManager = new PiSessionManager(undefined, {
        durableJournal: { enabled: true, dataDir: journalDir },
      });
      await localManager.initialize();

      const recovery = await localManager.executeCommand({ type: "get_startup_recovery" } as any);
      assert.strictEqual(recovery.success, true);

      const recoveryData = (recovery as any).data;
      assert.ok(recoveryData.malformedEntries >= 1, "Expected malformed entry count");
      assert.strictEqual(recoveryData.recoveredOutcomes, 2);
      assert.strictEqual(recoveryData.recoveredInFlightFailures, 1);

      const replayFinished = await localManager.executeCommand({
        id: "chaos-finished-1",
        type: "list_sessions",
      } as any);
      assert.strictEqual(replayFinished.success, true);
      assert.strictEqual(replayFinished.replayed, true);

      const replayInflight = await localManager.executeCommand({
        id: "chaos-inflight-1",
        type: "list_sessions",
      } as any);
      assert.strictEqual(replayInflight.success, false);
      assert.strictEqual(replayInflight.replayed, true);
      assert.ok(replayInflight.error?.includes("did not finish before previous shutdown"));

      localManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: compaction drops malformed partial lines and preserves replay", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-chaos-compaction-"));

    try {
      const journalPath = join(journalDir, "command-journal.jsonl");
      const now = Date.now();
      const lines = [
        JSON.stringify({
          schemaVersion: 1,
          kind: "command_lifecycle",
          phase: "command_finished",
          recordedAt: now - 3000,
          serverVersion: "test",
          commandId: "chaos-compact-old",
          commandType: "list_sessions",
          laneKey: "server",
          laneSequence: 1,
          fingerprint: JSON.stringify({ type: "list_sessions" }),
          explicitId: true,
          success: true,
          response: {
            id: "chaos-compact-old",
            type: "response",
            command: "list_sessions",
            success: true,
            data: { sessions: [] },
          },
        }),
        '{"schemaVersion":1,"kind":"command_lifecycle","phase":"command_started"',
        JSON.stringify({
          schemaVersion: 1,
          kind: "command_lifecycle",
          phase: "command_finished",
          recordedAt: now - 1000,
          serverVersion: "test",
          commandId: "chaos-compact-new",
          commandType: "list_sessions",
          laneKey: "server",
          laneSequence: 2,
          fingerprint: JSON.stringify({ type: "list_sessions" }),
          explicitId: true,
          success: true,
          response: {
            id: "chaos-compact-new",
            type: "response",
            command: "list_sessions",
            success: true,
            data: { sessions: [] },
          },
        }),
      ];
      writeFileSync(journalPath, `${lines.join("\n")}\n`, "utf-8");

      const localManager = new PiSessionManager(undefined, {
        durableJournal: {
          enabled: true,
          dataDir: journalDir,
          retention: { maxEntries: 1 },
        },
      });
      await localManager.initialize();

      const compactedRaw = readFileSync(journalPath, "utf-8");
      const compactedLines = compactedRaw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      assert.ok(compactedLines.length > 0, "Compacted journal should contain retained entries");
      for (const line of compactedLines) {
        assert.doesNotThrow(() => JSON.parse(line), `Expected parseable compacted line: ${line}`);
      }

      const oldReplay = await localManager.executeCommand({
        id: "chaos-compact-old",
        type: "list_sessions",
      } as any);
      assert.strictEqual(oldReplay.success, true);
      assert.notStrictEqual(oldReplay.replayed, true, "Old entry should be compacted out");

      const newReplay = await localManager.executeCommand({
        id: "chaos-compact-new",
        type: "list_sessions",
      } as any);
      assert.strictEqual(newReplay.success, true);
      assert.strictEqual(newReplay.replayed, true, "Newest retained entry should replay");

      localManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: get_startup_recovery remains available when durable init fails", async () => {
    const localManager = new PiSessionManager(undefined, {
      durableJournal: { enabled: true, dataDir: "/dev/null/pi-startup-recovery-failure" },
    });

    const summary = await localManager.executeCommand({ type: "get_startup_recovery" });
    assert.strictEqual(summary.success, true, "Recovery summary command should remain available");

    const data = (summary as any).data;
    assert.strictEqual(data.enabled, true);
    assert.ok(
      data.initState === "failed" || data.initState === "timed_out",
      `Expected failed or timed_out init state, got ${data.initState}`
    );
    assert.ok(
      typeof data.initializationError === "string" && data.initializationError.length > 0,
      "Should expose initializationError"
    );

    const normalCommand = await localManager.executeCommand({ type: "list_sessions" });
    assert.strictEqual(normalCommand.success, false, "Normal commands should still fail closed");
    assert.ok(normalCommand.error?.includes("Durable journal initialization failed"));
  });

  await test("session-manager: unsupported virtual fs journal path fails fast", async () => {
    if (process.platform !== "linux") {
      return;
    }

    const localManager = new PiSessionManager(undefined, {
      durableJournal: { enabled: true, dataDir: "/proc/pi-startup-recovery-failure" },
    });

    const startedAt = Date.now();
    const response = await localManager.executeCommand({ type: "list_sessions" });
    const elapsedMs = Date.now() - startedAt;

    assert.strictEqual(response.success, false);
    assert.ok(elapsedMs < 2000, `Expected fast failure (<2s), got ${elapsedMs}ms`);
    assert.ok(response.error?.includes("unsupported virtual filesystem root"));
  });

  await test("session-manager: durable journal lock rejects active foreign owner", async () => {
    if (process.platform === "win32") {
      return;
    }

    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-lock-foreign-"));
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });

    try {
      const holderPid = holder.pid;
      assert.ok(typeof holderPid === "number" && holderPid > 0, "Expected holder PID");

      const lockPath = join(journalDir, "command-journal.jsonl.lock");
      writeFileSync(lockPath, `${JSON.stringify({ pid: holderPid, acquiredAt: Date.now() })}\n`);

      const localManager = new PiSessionManager(undefined, {
        durableJournal: { enabled: true, dataDir: journalDir },
      });

      const response = await localManager.executeCommand({ type: "list_sessions" });
      assert.strictEqual(response.success, false);
      assert.ok(response.error?.includes("already in use by PID"));
      localManager.disposeAllSessions();
    } finally {
      try {
        holder.kill("SIGKILL");
      } catch {
        // Ignore process cleanup failures.
      }
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("command-journal: initialization failure releases writer lock", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-lock-release-"));
    const journalPath = join(journalDir, "command-journal.jsonl");
    mkdirSync(journalPath, { recursive: true });

    try {
      const journal = new DurableCommandJournal({ enabled: true, filePath: journalPath });
      await assert.rejects(() => journal.initialize(), /EISDIR|illegal operation on a directory/);
      assert.strictEqual(
        existsSync(`${journalPath}.lock`),
        false,
        "Init failure must release the journal lock"
      );
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  await test("session-manager: get_startup_recovery caps large recovery lists", async () => {
    const journalDir = mkdtempSync(join(tmpdir(), "pi-server-journal-recovery-cap-"));

    try {
      const seededJournal = new DurableCommandJournal({
        enabled: true,
        dataDir: journalDir,
      });
      await seededJournal.initialize();

      for (let i = 0; i < 150; i++) {
        const commandId = `cap-cmd-${i}`;
        seededJournal.appendLifecycle({
          phase: "command_finished",
          commandId,
          commandType: "list_sessions",
          laneKey: "server",
          fingerprint: JSON.stringify({ type: "list_sessions" }),
          explicitId: true,
          success: true,
          response: {
            id: commandId,
            type: "response",
            command: "list_sessions",
            success: true,
            data: { sessions: [] },
          },
        });
      }
      seededJournal.dispose();

      const localManager = new PiSessionManager(undefined, {
        durableJournal: { enabled: true, dataDir: journalDir },
      });
      await localManager.initialize();

      const summary = await localManager.executeCommand({ type: "get_startup_recovery" });
      assert.strictEqual(summary.success, true);

      const data = (summary as any).data;
      assert.strictEqual(data.recoveredOutcomes, 150);
      assert.strictEqual(data.recoveredOutcomeIds.length, 100);
      assert.strictEqual(data.recoveredOutcomeIdsTruncated, true);
      assert.strictEqual(data.maxItemsReturned, 100);
      assert.strictEqual(data.recoveredInFlightTruncated, false);

      localManager.disposeAllSessions();
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });

  // Test: list_stored_sessions (ADR-0007)
  await test("session-manager: list_stored_sessions returns empty initially", async () => {
    const response = await manager.executeCommand({ type: "list_stored_sessions" });
    assert.strictEqual(response.success, true, "list_stored_sessions should succeed");
    assert.ok(Array.isArray((response as any).data.sessions), "Should have sessions array");
  });

  await test("session-store: discovers project-local session files", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pi-session-store-discover-"));
    const sessionsDir = mkdtempSync(join(tmpdir(), "pi-session-store-global-"));
    const projectSessionsDir = join(process.cwd(), ".pi", "sessions");
    const sessionPath = join(projectSessionsDir, `discover-${Date.now()}.jsonl`);
    const store = new SessionStore({ dataDir, sessionsDir, serverVersion: "test" });

    try {
      mkdirSync(projectSessionsDir, { recursive: true });
      writeFileSync(
        sessionPath,
        JSON.stringify({
          type: "session",
          version: 3,
          id: `discover-${Date.now()}`,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }) + "\n"
      );

      const discovered = await store.discoverSessions();
      assert(
        discovered.some((session) => session.sessionPath === sessionPath),
        "Expected project-local session file to be discoverable"
      );
    } finally {
      rmSync(sessionPath, { force: true });
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  await test("session-store: discovery sanitizes malformed session header fields", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "pi-session-store-malformed-header-"));
    const projectDir = join(baseDir, "project");
    const homeDir = join(baseDir, "home");
    const dataDir = join(baseDir, "data");
    const sessionsDir = join(baseDir, "global-sessions");
    const projectSessionsDir = join(projectDir, ".pi", "sessions");
    const sessionPath = join(projectSessionsDir, `malformed-${Date.now()}.jsonl`);
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();

    try {
      mkdirSync(projectSessionsDir, { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      writeFileSync(
        sessionPath,
        JSON.stringify({
          type: "session",
          version: 3,
          cwd: { bad: true },
          sessionName: { nope: true },
        }) + "\n"
      );

      process.env.HOME = homeDir;
      process.chdir(projectDir);

      const store = new SessionStore({ dataDir, sessionsDir, serverVersion: "test" });
      const grouped = await store.listSessionsGrouped();
      assert.strictEqual(grouped.length, 1);
      assert.strictEqual(grouped[0]?.cwd, "/unknown");
      assert.strictEqual(grouped[0]?.displayPath, "/unknown");
      assert.strictEqual(grouped[0]?.sessions[0]?.sessionName, undefined);
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  // Test: create_session persists metadata (ADR-0007)
  await test("session-manager: create_session persists metadata", async () => {
    const manager = new PiSessionManager();

    // Create a session
    await manager.executeCommand({ type: "create_session", sessionId: "persist-test" });

    // List stored sessions should include it
    const response = await manager.executeCommand({ type: "list_stored_sessions" });
    assert.strictEqual(response.success, true, "list_stored_sessions should succeed");

    const sessions = (response as any).data.sessions;
    const found = sessions.find((s: any) => s.sessionId === "persist-test");
    assert.ok(found, "Should find persisted session");
    // Note: fileExists may be false if the session file is in a different location
    // The important thing is that the metadata was persisted
    assert.ok(found.sessionFile, "Should have session file path");
    assert.ok(found.createdAt, "Should have createdAt");

    // Cleanup
    await manager.executeCommand({ type: "delete_session", sessionId: "persist-test" });
  });

  // Test: delete_session removes metadata (ADR-0007)
  await test("session-manager: delete_session removes metadata", async () => {
    const manager = new PiSessionManager();

    // Create and then delete a session
    await manager.executeCommand({ type: "create_session", sessionId: "delete-persist-test" });
    await manager.executeCommand({ type: "delete_session", sessionId: "delete-persist-test" });

    // List stored sessions should not include it
    const response = await manager.executeCommand({ type: "list_stored_sessions" });
    const sessions = (response as any).data.sessions;
    const found = sessions.find((s: any) => s.sessionId === "delete-persist-test");
    assert.ok(!found, "Should not find deleted session in stored sessions");
  });

  // Test: disposeAllSessions
  await test("session-manager: disposeAllSessions cleans up", async () => {
    const manager = new PiSessionManager();

    // Create sessions
    await manager.executeCommand({ type: "create_session", sessionId: "dispose1" });
    await manager.executeCommand({ type: "create_session", sessionId: "dispose2" });

    // Verify sessions exist
    const listBefore = await manager.executeCommand({ type: "list_sessions" });
    assert.strictEqual((listBefore as any).data.sessions.length, 2, "Should have 2 sessions");

    // Dispose all
    const result = manager.disposeAllSessions();
    assert.strictEqual(result.disposed, 2, "Should dispose 2 sessions");
    assert.strictEqual(result.failed, 0, "Should have 0 failures");

    // Verify sessions are gone
    const listAfter = await manager.executeCommand({ type: "list_sessions" });
    assert.strictEqual((listAfter as any).data.sessions.length, 0, "Should have 0 sessions");
    assert.strictEqual(manager.getGovernor().getSessionCount(), 0, "Governor count must reset");

    const recreated = await manager.executeCommand({
      type: "create_session",
      sessionId: "dispose3",
    });
    assert.strictEqual(recreated.success, true, recreated.error);
    await manager.executeCommand({ type: "delete_session", sessionId: "dispose3" });
  });

  await test("session-store: failed save does not mutate cached metadata", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pi-session-store-copy-on-write-"));
    const store = new SessionStore({ dataDir, sessionsDir: dataDir, serverVersion: "test" });

    try {
      await store.save({
        sessionId: "a",
        sessionFile: join(dataDir, "a.jsonl"),
        cwd: dataDir,
        createdAt: new Date().toISOString(),
      });

      (store as any).saveMetadata = async () => {
        throw new Error("disk full");
      };

      await assert.rejects(
        () =>
          store.save({
            sessionId: "b",
            sessionFile: join(dataDir, "b.jsonl"),
            cwd: dataDir,
            createdAt: new Date().toISOString(),
          }),
        /disk full/
      );

      const cachedSessionIds = (await store.list()).map((entry) => entry.sessionId).sort();
      assert.deepStrictEqual(cachedSessionIds, ["a"]);

      const persisted = JSON.parse(readFileSync(join(dataDir, "sessions-metadata.json"), "utf-8"));
      assert.deepStrictEqual(
        persisted.sessions.map((entry: any) => entry.sessionId),
        ["a"]
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await test("session-store: serializes concurrent metadata mutations across instances", async () => {
    for (let iteration = 0; iteration < 50; iteration++) {
      const dataDir = mkdtempSync(join(tmpdir(), "pi-session-store-race-"));
      const storeA = new SessionStore({ dataDir, sessionsDir: dataDir, serverVersion: "test" });
      const storeB = new SessionStore({ dataDir, sessionsDir: dataDir, serverVersion: "test" });
      const makeMeta = (sessionId: string) => ({
        sessionId,
        sessionFile: join(dataDir, `${sessionId}.jsonl`),
        cwd: dataDir,
        createdAt: new Date().toISOString(),
      });

      try {
        writeFileSync(join(dataDir, "a.jsonl"), "");
        writeFileSync(join(dataDir, "b.jsonl"), "");

        await Promise.all([storeA.save(makeMeta("a")), storeB.save(makeMeta("b"))]);

        const sessionIds = (await storeA.list()).map((entry) => entry.sessionId).sort();
        assert.deepStrictEqual(sessionIds, ["a", "b"], `iteration ${iteration}`);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  });

  await test("server: forwards durableInitTimeoutMs to session manager", () => {
    const server = new PiServer({ durableInitTimeoutMs: 1234 } as any);
    const managerAny = server.getSessionManager() as any;
    assert.strictEqual(managerAny.durableInitTimeoutMs, 1234);
  });

  await test("server: auth provider throw closes websocket without unhandled rejection", async () => {
    const server = new PiServer({
      authProvider: {
        authenticate() {
          throw new Error("boom-auth");
        },
      },
      startupRecoverySummaryEvent: { enabled: false },
    } as any);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      await server.start(0);
      const port = Number((server as any).wss?.address?.().port);
      assert(Number.isFinite(port) && port > 0, "Expected ephemeral WebSocket port");

      const closeEvent = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const timer = setTimeout(() => reject(new Error("Timed out waiting for close")), 2000);

        ws.on("close", (code, reason) => {
          clearTimeout(timer);
          resolve({ code, reason: reason.toString() });
        });
        ws.on("error", () => {
          // Connection is expected to fail closed.
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.strictEqual(closeEvent.code, 1008, "Expected policy violation close code");
      assert(
        closeEvent.reason.includes("Authentication"),
        `Unexpected close reason: ${closeEvent.reason}`
      );
      assert.strictEqual(
        unhandled.length,
        0,
        "Auth throw should not escape as unhandled rejection"
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await server.stop(1000);
    }
  });

  await test("server: auth identity is propagated into command execution context", async () => {
    const server = new PiServer({
      authProvider: {
        authenticate() {
          return { allowed: true, identity: "user-alice" };
        },
      },
      startupRecoverySummaryEvent: { enabled: false },
    });

    let capturedPrincipal: string | undefined;
    const managerAny = server.getSessionManager() as any;
    managerAny.executeCommand = async (command: any, options: { principal?: string } = {}) => {
      capturedPrincipal = options.principal;
      return {
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: { sessions: [] },
      };
    };

    try {
      await server.start(0);
      const port = Number((server as any).wss?.address?.().port);
      assert(Number.isFinite(port) && port > 0, "Expected ephemeral WebSocket port");

      const response = await new Promise<any>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const timer = setTimeout(() => reject(new Error("Timed out waiting for response")), 4000);

        ws.on("message", (data) => {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === "server_ready") {
            ws.send(JSON.stringify({ id: "principal-1", type: "list_sessions" }));
            return;
          }
          if (parsed.type === "response" && parsed.id === "principal-1") {
            clearTimeout(timer);
            ws.close();
            resolve(parsed);
          }
        });
        ws.on("error", reject);
      });

      assert.strictEqual(response.success, true);
      assert.strictEqual(capturedPrincipal, "user-alice");
    } finally {
      await server.stop(1000);
    }
  });

  await test("server: per-connection pending command cap rejects overflow", async () => {
    const server = new PiServer({
      maxPendingCommandsPerConnection: 1,
      startupRecoverySummaryEvent: { enabled: false },
    });

    let releaseFirst!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const managerAny = server.getSessionManager() as any;
    managerAny.executeCommand = async (command: any) => {
      await blocker;
      return {
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: { sessions: [] },
      };
    };

    try {
      await server.start(0);
      const port = Number((server as any).wss?.address?.().port);
      assert(Number.isFinite(port) && port > 0, "Expected ephemeral WebSocket port");

      const result = await new Promise<{ first: any; overflow: any }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const seen: { first?: any; overflow?: any } = {};
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for capped responses")),
          5000
        );

        ws.on("message", (data) => {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === "server_ready") {
            ws.send(JSON.stringify({ id: "cap-1", type: "list_sessions" }));
            ws.send(JSON.stringify({ id: "cap-2", type: "list_sessions" }));
            return;
          }
          if (parsed.type === "response" && parsed.id === "cap-2") {
            seen.overflow = parsed;
            releaseFirst();
            return;
          }
          if (parsed.type === "response" && parsed.id === "cap-1") {
            seen.first = parsed;
          }
          if (seen.first && seen.overflow) {
            clearTimeout(timer);
            ws.close();
            resolve({ first: seen.first, overflow: seen.overflow });
          }
        });
        ws.on("error", reject);
      });

      assert.strictEqual(result.overflow.success, false);
      assert.ok(String(result.overflow.error || "").includes("Too many pending commands"));
      assert.strictEqual(result.first.success, true);
    } finally {
      releaseFirst?.();
      await server.stop(1000);
    }
  });

  await test("server: shutdown flush includes final uptime metric", async () => {
    const sink = new BufferedTestSink();
    const server = new PiServer({
      metricsSink: sink,
      includeMemoryMetrics: false,
    });

    await server.start(0);
    await server.stop(1000);

    assert.strictEqual(
      sink.hasFlushedMetric(MetricNames.SESSION_LIFETIME_SECONDS),
      true,
      "Expected uptime metric to be included in flushed metrics"
    );
  });

  await test("server: shutdown disposes logger and metrics sink", async () => {
    let metricsDisposed = false;
    let loggerDisposed = false;

    const server = new PiServer({
      metricsSink: {
        record() {},
        async flush() {},
        async dispose() {
          metricsDisposed = true;
        },
      },
      logger: {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        logError() {},
        child() {
          return this;
        },
        getLevel() {
          return "info" as const;
        },
        setLevel() {},
        isLevelEnabled() {
          return false;
        },
        async dispose() {
          loggerDisposed = true;
        },
      },
      includeMemoryMetrics: false,
      startupRecoverySummaryEvent: { enabled: false },
    });

    await server.start(0);
    await server.stop(1000);

    assert.strictEqual(metricsDisposed, true, "Expected metrics sink dispose to run");
    assert.strictEqual(loggerDisposed, true, "Expected logger dispose to run");
  });

  await test("server: starts in degraded mode when durable init fails", async () => {
    if (process.platform !== "linux") {
      return;
    }

    const server = new PiServer({
      durableJournal: { enabled: true, dataDir: "/dev/null/pi-startup-fail-test" },
    });

    await server.start(0);
    try {
      const summary = await server.getSessionManager().executeCommand({
        type: "get_startup_recovery",
      } as any);
      assert.strictEqual(summary.success, true);
      const data = (summary as any).data;
      assert.ok(data.initState === "failed" || data.initState === "timed_out");

      const normal = await server.getSessionManager().executeCommand({
        type: "list_sessions",
      } as any);
      assert.strictEqual(normal.success, false, "Non-recovery commands should fail closed");
      assert.ok(normal.error?.includes("Durable journal initialization failed"));
    } finally {
      await server.stop(1000);
    }
  });

  await test("server: startup_recovery_summary can include sensitive fields via opt-in", async () => {
    const server = new PiServer({
      startupRecoverySummaryEvent: {
        enabled: true,
        includeSensitiveData: true,
      },
    });

    const captured: Array<Record<string, unknown>> = [];
    const subscriber = {
      send: (data: string) => {
        captured.push(JSON.parse(data));
      },
      subscribedSessions: new Set<string>(),
    };

    server.getSessionManager().addSubscriber(subscriber);

    await server.start(0);
    try {
      const startupRecovery = captured.find((event) => event.type === "startup_recovery_summary");
      assert.ok(startupRecovery, "Expected startup_recovery_summary broadcast");
      assert.notStrictEqual(
        (startupRecovery as any).data?.journalPath,
        "[redacted]",
        "Opt-in sensitive mode should include journalPath"
      );
    } finally {
      server.getSessionManager().removeSubscriber(subscriber);
      await server.stop(1000);
    }
  });

  await test("server: stdio transport registers and unregisters stdout error handler", async () => {
    const before = process.stdout.listenerCount("error");
    const server = new PiServer({ startupRecoverySummaryEvent: { enabled: false } });

    await server.start(0);
    try {
      assert.strictEqual(
        process.stdout.listenerCount("error"),
        before + 1,
        "Expected server to attach stdout error handler"
      );
    } finally {
      await server.stop(1000);
    }

    assert.strictEqual(
      process.stdout.listenerCount("error"),
      before,
      "Expected server to detach stdout error handler on stop"
    );
  });

  await test("stdio backpressure: drops non-critical writes while backpressured", () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const writes: string[] = [];

    (process.stdout as any).write = (chunk: string) => {
      writes.push(String(chunk));
      return false;
    };

    const state = {
      hasBackpressure: false,
      droppedCount: 0,
      drainHandlerRegistered: false,
    };

    try {
      const first = sendWithStdioBackpressure("first", state, { isCritical: false });
      const second = sendWithStdioBackpressure("second", state, { isCritical: false });

      assert.strictEqual(first, true, "First write should be attempted");
      assert.strictEqual(second, false, "Second write should be dropped under backpressure");
      assert.strictEqual(writes.length, 1, "Dropped write should not hit stdout.write");
      assert.strictEqual(state.droppedCount, 1, "Dropped counter should increment");
    } finally {
      (process.stdout as any).write = originalWrite;
    }
  });

  await test("stdio backpressure: drain resets pressure and critical writes still attempt", () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const writes: string[] = [];
    let writeCalls = 0;

    (process.stdout as any).write = (chunk: string) => {
      writes.push(String(chunk));
      writeCalls += 1;
      // First write simulates buffer full, subsequent writes are accepted.
      return writeCalls > 1;
    };

    const state = {
      hasBackpressure: false,
      droppedCount: 0,
      drainHandlerRegistered: false,
    };

    try {
      const firstCritical = sendWithStdioBackpressure("critical-1", state, { isCritical: true });
      assert.strictEqual(firstCritical, true, "Critical write should always be attempted");
      assert.strictEqual(state.hasBackpressure, true, "State should enter backpressure");
      assert.strictEqual(state.drainHandlerRegistered, true, "Drain handler should be registered");

      const nonCritical = sendWithStdioBackpressure("non-critical", state, { isCritical: false });
      assert.strictEqual(nonCritical, false, "Non-critical write should drop while backpressured");
      assert.strictEqual(writes.length, 1, "Dropped non-critical write should not reach stdout");
      assert.strictEqual(state.droppedCount, 1, "Dropped counter should increment");

      // Simulate drain from previous write cycle.
      (process.stdout as any).emit("drain");
      assert.strictEqual(state.hasBackpressure, false, "Drain should clear backpressure state");
      assert.strictEqual(
        state.drainHandlerRegistered,
        false,
        "Drain should clear handler registration flag"
      );

      const secondCritical = sendWithStdioBackpressure("critical-2", state, { isCritical: true });
      assert.strictEqual(secondCritical, true, "Critical write should be attempted after drain");
      assert.strictEqual(writes.length, 2, "Critical writes should reach stdout");
    } finally {
      (process.stdout as any).write = originalWrite;
    }
  });
}

// =============================================================================
// RUN ALL TESTS
// =============================================================================

async function runExternalTestScript(scriptName: string): Promise<void> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = join(currentDir, scriptName);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-vm-modules", scriptPath], {
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${scriptName} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

async function main() {
  console.log("🧪 pi-server Tests\n");

  await testValidation();
  await testSessionPathValidation();
  await testCommandRouter();
  await testResourceGovernor();
  await testExtensionUI();
  await testSessionManager();

  // Run standalone suite for bash circuit breaker
  await test("bash-circuit-breaker: standalone suite", async () => {
    await runExternalTestScript("test-bash-circuit-breaker.js");
  });

  console.log("\n" + "=".repeat(50));
  console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

main().catch(console.error);
