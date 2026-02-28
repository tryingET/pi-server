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

    // Valid paths (absolute and relative)
    assert.strictEqual(governor.validateCwd("/absolute/path"), null);
    assert.strictEqual(governor.validateCwd("relative/path"), null);

    // Invalid paths
    assert(governor.validateCwd("../../../etc")?.includes("dangerous"));
    assert(governor.validateCwd("~/home")?.includes("dangerous"));
    assert(governor.validateCwd("")?.includes("non-empty"));
    assert(governor.validateCwd(null as any)?.includes("non-empty"));
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
}

// =============================================================================
// SESSION MANAGER TESTS
// =============================================================================

import { PiSessionManager } from "./session-manager.js";
import { PiServer } from "./server.js";
import { MetricNames, type MetricEvent, type MetricsSink } from "./metrics-types.js";

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

  await test("session-manager: emits command_finished for admitted rate-limited commands", async () => {
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
    const finished = events.find(
      (e) => e.type === "command_finished" && e.data?.commandId === "rl-lifecycle-2"
    );

    assert.ok(accepted, "Expected command_accepted event for rate-limited command");
    assert.ok(finished, "Expected command_finished event for rate-limited command");
    assert.strictEqual(finished.data.success, false, "Finished event should report failure");

    localManager.removeSubscriber(subscriber);
  });

  await test("session-manager: create_session ignores npm_config_prefix leakage", async () => {
    const previousPrefix = process.env.npm_config_prefix;
    process.env.npm_config_prefix = process.cwd();

    const localManager = new PiSessionManager();
    try {
      const created = await localManager.executeCommand({
        type: "create_session",
        sessionId: "prefix-sanitize",
      });

      assert.strictEqual(
        created.success,
        true,
        `Session creation should succeed with sanitized npm prefix: ${created.error}`
      );

      await localManager.executeCommand({
        type: "delete_session",
        sessionId: "prefix-sanitize",
      });
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

    const created = await localManager.executeCommand({
      type: "create_session",
      sessionId: "load-src",
    });
    assert.strictEqual(created.success, true);

    const sessionPath = (created as any).data.sessionInfo.sessionFile;
    assert.ok(sessionPath, "Expected source session file");

    await localManager.executeCommand({ type: "delete_session", sessionId: "load-src" });

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

    // Cleanup
    await manager.executeCommand({ type: "delete_session", sessionId: "metrics-test" });
  });

  // Test: list_stored_sessions (ADR-0007)
  await test("session-manager: list_stored_sessions returns empty initially", async () => {
    const response = await manager.executeCommand({ type: "list_stored_sessions" });
    assert.strictEqual(response.success, true, "list_stored_sessions should succeed");
    assert.ok(Array.isArray((response as any).data.sessions), "Should have sessions array");
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
