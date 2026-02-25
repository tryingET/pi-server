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

  // Test: Format validation errors
  await test("validation: formatValidationErrors works", () => {
    const formatted = formatValidationErrors([
      { field: "type", message: "Required" },
      { field: "sessionId", message: "Must be a string" },
    ]);
    assert(formatted.includes("type:"), "Should include field name");
    assert(formatted.includes("sessionId:"), "Should include field name");
  });
}

// =============================================================================
// COMMAND ROUTER TESTS
// =============================================================================

import { getSupportedSessionCommands } from "./command-router.js";

async function testCommandRouter() {
  console.log("\n=== Command Router Tests ===\n");

  // Test: Supported commands list
  await test("router: has expected commands", () => {
    const commands = getSupportedSessionCommands();
    assert(commands.includes("prompt"), "Should have prompt");
    assert(commands.includes("get_state"), "Should have get_state");
    assert(commands.includes("set_model"), "Should have set_model");
    assert(commands.includes("get_available_models"), "Should have get_available_models");
    assert(commands.length >= 25, `Should have at least 25 commands, got ${commands.length}`);
  });
}

// =============================================================================
// SESSION MANAGER TESTS
// =============================================================================

import { PiSessionManager } from "./session-manager.js";

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
    assert(response.error?.includes("Session test not found"), "Should mention session not found");
  });

  // Test: List sessions when empty
  await test("session-manager: lists empty sessions", async () => {
    const response = await manager.executeCommand({ type: "list_sessions" });
    assert.strictEqual(response.success, true, "Should succeed");
    assert.deepStrictEqual((response as any).data.sessions, [], "Should be empty array");
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
    await manager.executeCommand({ type: "create_session", sessionId: "switch-test" });
    const response = await manager.executeCommand({
      type: "switch_session",
      sessionId: "switch-test",
    });
    assert.strictEqual(response.success, true, "Should succeed");
    assert.strictEqual((response as any).data.sessionInfo.sessionId, "switch-test");

    // Cleanup
    await manager.executeCommand({ type: "delete_session", sessionId: "switch-test" });
  });
}

// =============================================================================
// RUN ALL TESTS
// =============================================================================

async function main() {
  console.log("🧪 pi-server Tests\n");

  await testValidation();
  await testCommandRouter();
  await testSessionManager();

  console.log("\n" + "=".repeat(50));
  console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

main().catch(console.error);
