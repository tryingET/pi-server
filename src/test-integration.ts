/**
 * Integration tests for pi-server.
 *
 * Tests the actual WebSocket wire protocol.
 * Run with: node --experimental-vm-modules dist/test-integration.js
 *
 * Requires: pi-coding-agent (for real session creation)
 */

import assert from "assert";
import { spawn } from "child_process";
import * as readline from "readline";
import { WebSocket } from "ws";
import getPort from "get-port";
import { PiServer } from "./server.js";

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
// TEST HARNESS
// =============================================================================

interface TestContext {
  server: PiServer;
  port: number;
}

/**
 * Run a test suite with a fresh server instance.
 * Ensures proper isolation between test suites.
 */
async function withFreshServer(fn: (ctx: TestContext) => Promise<void>): Promise<void> {
  // Get a free port
  const port = await getPort();
  const server = new PiServer();

  try {
    await server.start(port);

    // Wait for server to be ready (check that we can connect)
    await waitForServerReady(port);

    await fn({ server, port });
  } finally {
    await server.stop(5000);
  }
}

/**
 * Wait for server to be ready to accept connections.
 */
async function waitForServerReady(port: number, maxAttempts = 10): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        ws.on("open", () => {
          ws.close();
          resolve();
        });
        ws.on("error", () => {
          reject(new Error("Connection failed"));
        });
      });
      return; // Success
    } catch {
      await sleep(50);
    }
  }
  throw new Error(`Server not ready after ${maxAttempts} attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJsonLine(
  lines: readline.Interface,
  predicate: (obj: Record<string, unknown>) => boolean,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      lines.off("line", onLine);
      reject(new Error("Timed out waiting for JSON line"));
    }, timeoutMs);

    const onLine = (line: string) => {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (predicate(obj)) {
          clearTimeout(timer);
          lines.off("line", onLine);
          resolve(obj);
        }
      } catch {
        // ignore non-JSON lines
      }
    };

    lines.on("line", onLine);
  });
}

// =============================================================================
// WEBSOCKET CLIENT HELPER
// =============================================================================

interface WSMessage {
  type: string;
  command?: string;
  success?: boolean;
  error?: string;
  id?: string;
  data?: {
    sessionId?: string;
    sessionInfo?: unknown;
    sessions?: unknown[];
    deleted?: boolean;
    sessionCount?: number;
    connectionCount?: number;
    totalCommandsExecuted?: number;
    commandsRejected?: {
      sessionLimit: number;
      messageSize: number;
      rateLimit: number;
      globalRateLimit: number;
      connectionLimit: number;
    };
    zombieSessionsDetected?: number;
    zombieSessionsCleaned?: number;
    doubleUnregisterErrors?: number;
    rateLimitUsage?: {
      globalCount: number;
      globalLimit: number;
    };
    healthy?: boolean;
    issues?: string[];
    reason?: string;
    timeoutMs?: number;
    serverVersion?: string;
    protocolVersion?: string;
    transports?: string[];
  };
  [key: string]: unknown;
}

class TestClient {
  private ws: WebSocket | null = null;
  private messages: WSMessage[] = [];
  private connected = false;
  private resolveConnect: (() => void) | null = null;

  async connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${port}`);

      this.ws.on("open", () => {
        this.connected = true;
        this.resolveConnect?.();
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.messages.push(msg);
        } catch {
          // Ignore parse errors
        }
      });

      this.ws.on("error", (err) => {
        if (!this.connected) {
          reject(err);
        }
      });

      this.ws.on("close", () => {
        this.connected = false;
      });
    });
  }

  async send(command: object): Promise<void> {
    if (!this.ws || !this.connected) {
      throw new Error("Not connected");
    }
    return new Promise((resolve, reject) => {
      this.ws!.send(JSON.stringify(command), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Wait for a message matching the predicate.
   * Returns the message or throws on timeout.
   */
  async waitForMessage(
    predicate: (msg: WSMessage) => boolean,
    timeoutMs = 5000
  ): Promise<WSMessage> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const msg = this.messages.find(predicate);
      if (msg) {
        // Remove from queue so it's not matched again
        this.messages = this.messages.filter((m) => m !== msg);
        return msg;
      }
      await sleep(50);
    }

    throw new Error(
      `Timeout waiting for message. Got ${this.messages.length} messages: ${JSON.stringify(this.messages)}`
    );
  }

  /**
   * Send a raw string (for testing malformed data).
   */
  async sendRaw(data: string): Promise<void> {
    if (!this.ws || !this.connected) {
      throw new Error("Not connected");
    }
    return new Promise((resolve, reject) => {
      this.ws!.send(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Get all received messages.
   */
  getMessages(): WSMessage[] {
    return [...this.messages];
  }

  /**
   * Clear message buffer.
   */
  clearMessages(): void {
    this.messages = [];
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Close connection.
   */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

async function testServerReady() {
  console.log("\n=== Server Ready Tests ===\n");

  await withFreshServer(async (ctx) => {
    await test("integration: receives server_ready on connect", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);

      const readyMsg = await client.waitForMessage((msg) => msg.type === "server_ready", 2000);

      assert.strictEqual(readyMsg.type, "server_ready");
      assert.ok(readyMsg.data, "Should have data");
      assert.ok(typeof readyMsg.data.serverVersion === "string", "Should have serverVersion");
      assert.ok(typeof readyMsg.data.protocolVersion === "string", "Should have protocolVersion");
      assert.ok(Array.isArray(readyMsg.data.transports), "Should have transports");
      assert.ok(readyMsg.data.transports.includes("websocket"), "Should support websocket");

      client.close();
    });

    await test("integration: protocol version is 1.0.0", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);

      const readyMsg = await client.waitForMessage((msg) => msg.type === "server_ready");

      assert.ok(readyMsg.data, "Should have data");
      assert.strictEqual(readyMsg.data!.protocolVersion, "1.0.0");

      client.close();
    });
  });
}

async function testCommandResponse() {
  console.log("\n=== Command/Response Tests ===\n");

  await withFreshServer(async (ctx) => {
    await test("integration: list_sessions returns empty array", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages(); // Clear server_ready

      await client.send({ type: "list_sessions" });

      const response = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.command === "list_sessions"
      );

      assert.strictEqual(response.success, true);
      assert.ok(Array.isArray(response.data?.sessions), "Should have sessions array");
      assert.strictEqual(response.data.sessions.length, 0, "Should be empty initially");

      client.close();
    });

    await test("integration: create_session returns sessionId", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ type: "create_session", sessionId: "test-session-1" });

      const response = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.command === "create_session"
      );

      assert.strictEqual(response.success, true);
      assert.strictEqual(response.data?.sessionId, "test-session-1");
      assert.ok(response.data?.sessionInfo, "Should have sessionInfo");

      // Cleanup
      await client.send({ type: "delete_session", sessionId: "test-session-1" });

      client.close();
    });

    await test("integration: delete_session removes session", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      // Create
      await client.send({ type: "create_session", sessionId: "test-session-2" });
      await client.waitForMessage((msg) => msg.command === "create_session");

      // Delete
      await client.send({ type: "delete_session", sessionId: "test-session-2" });
      const response = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.command === "delete_session"
      );

      assert.strictEqual(response.success, true);
      assert.strictEqual(response.data?.deleted, true);

      // Verify gone
      await client.send({ type: "list_sessions" });
      const listResponse = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.command === "list_sessions"
      );
      assert.ok(listResponse.data?.sessions, "Should have sessions");
      assert.strictEqual(listResponse.data!.sessions!.length, 0);

      client.close();
    });

    await test("integration: invalid JSON returns error", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      // Send invalid JSON
      await client.sendRaw("{not valid json");

      const response = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.success === false
      );

      assert.strictEqual(response.success, false);
      assert.ok(response.error, "Should have error message");

      client.close();
    });

    await test("integration: missing type returns error", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ sessionId: "test" });

      const response = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.success === false
      );

      assert.strictEqual(response.success, false);
      assert.ok(response.error?.includes("type"), "Error should mention type");

      client.close();
    });

    await test("integration: unknown command type returns error", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ type: "unknown_command_xyz" });

      const response = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.success === false
      );

      assert.strictEqual(response.success, false);

      client.close();
    });

    await test("integration: serializes create -> steer -> follow_up on same session lane", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ id: "burst-1", type: "create_session", sessionId: "burst-order" });
      await client.send({
        id: "burst-2",
        type: "steer",
        sessionId: "burst-order",
        message: "left",
      });
      await client.send({
        id: "burst-3",
        type: "follow_up",
        sessionId: "burst-order",
        message: "next",
      });

      const createResp = await client.waitForMessage((msg) => msg.id === "burst-1", 15000);
      const steerResp = await client.waitForMessage((msg) => msg.id === "burst-2", 15000);
      const followResp = await client.waitForMessage((msg) => msg.id === "burst-3", 15000);

      assert.strictEqual(createResp.success, true, "create_session should succeed");
      assert.strictEqual(steerResp.success, true, "steer should execute after create");
      assert.strictEqual(followResp.success, true, "follow_up should execute after create");

      await client.send({ type: "delete_session", sessionId: "burst-order" });
      client.close();
    });

    await test("integration: emits command lifecycle events", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ id: "life-1", type: "list_sessions" });

      const accepted = await client.waitForMessage(
        (msg) => msg.type === "command_accepted" && (msg.data as any)?.commandId === "life-1",
        8000
      );
      const started = await client.waitForMessage(
        (msg) => msg.type === "command_started" && (msg.data as any)?.commandId === "life-1",
        8000
      );
      const finished = await client.waitForMessage(
        (msg) => msg.type === "command_finished" && (msg.data as any)?.commandId === "life-1",
        8000
      );

      assert.strictEqual(accepted.type, "command_accepted");
      assert.strictEqual(started.type, "command_started");
      assert.strictEqual(finished.type, "command_finished");
      assert.strictEqual((finished.data as any)?.success, true);

      client.close();
    });

    await test("integration: rejects conflicting duplicate command IDs", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ id: "dup-int", type: "list_sessions" });
      await client.waitForMessage((msg) => msg.id === "dup-int" && msg.success === true, 8000);

      await client.send({ id: "dup-int", type: "health_check" });
      const conflict = await client.waitForMessage(
        (msg) => msg.id === "dup-int" && msg.success === false,
        8000
      );

      assert.strictEqual(conflict.success, false);
      assert.ok(conflict.error?.includes("Conflicting id 'dup-int'"));
      client.close();
    });

    await test("integration: rejects conflicting idempotency keys", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ id: "idem-int-1", type: "list_sessions", idempotencyKey: "idem-int" });
      await client.waitForMessage((msg) => msg.id === "idem-int-1" && msg.success === true, 8000);

      await client.send({ id: "idem-int-2", type: "health_check", idempotencyKey: "idem-int" });
      const conflict = await client.waitForMessage(
        (msg) => msg.id === "idem-int-2" && msg.success === false,
        8000
      );

      assert.strictEqual(conflict.success, false);
      assert.ok(conflict.error?.includes("Conflicting idempotencyKey 'idem-int'"));
      client.close();
    });
  });
}

async function testBroadcasts() {
  console.log("\n=== Broadcast Tests ===\n");

  await withFreshServer(async (ctx) => {
    await test("integration: session_created broadcast on create", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ type: "create_session", sessionId: "broadcast-test-1" });

      // Wait for response
      await client.waitForMessage((msg) => msg.command === "create_session");

      // Wait for broadcast
      const broadcast = await client.waitForMessage((msg) => msg.type === "session_created");

      assert.strictEqual(broadcast.type, "session_created");
      assert.strictEqual(broadcast.data?.sessionId, "broadcast-test-1");

      client.close();
    });

    await test("integration: session_deleted broadcast on delete", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      // Create
      await client.send({ type: "create_session", sessionId: "broadcast-test-2" });
      await client.waitForMessage((msg) => msg.command === "create_session");
      client.clearMessages();

      // Delete
      await client.send({ type: "delete_session", sessionId: "broadcast-test-2" });
      await client.waitForMessage((msg) => msg.command === "delete_session");

      // Wait for broadcast
      const broadcast = await client.waitForMessage((msg) => msg.type === "session_deleted");

      assert.strictEqual(broadcast.type, "session_deleted");
      assert.strictEqual(broadcast.data?.sessionId, "broadcast-test-2");

      client.close();
    });
  });
}

async function testMessageSize() {
  console.log("\n=== Message Size Tests ===\n");

  await withFreshServer(async (ctx) => {
    await test("integration: oversized message rejected", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      // Create a message larger than 10MB (default limit)
      const hugeMessage = "x".repeat(11 * 1024 * 1024);
      await client.send({ type: "prompt", sessionId: "test", message: hugeMessage });

      const response = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.success === false
      );

      assert.strictEqual(response.success, false);
      assert.ok(
        response.error?.toLowerCase().includes("size") ||
          response.error?.toLowerCase().includes("limit"),
        "Error should mention size/limit"
      );

      client.close();
    });
  });
}

async function testConnectionLimit() {
  console.log("\n=== Connection Limit Tests ===\n");

  await withFreshServer(async (ctx) => {
    await test("integration: get_metrics includes connection count", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ type: "get_metrics" });

      const response = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.command === "get_metrics"
      );

      assert.strictEqual(response.success, true);
      assert.ok(typeof response.data?.connectionCount === "number", "Should have connectionCount");
      assert.ok(response.data.connectionCount >= 1, "Should have at least 1 connection");

      client.close();
    });
  });
}

async function testMetrics() {
  console.log("\n=== Metrics Tests ===\n");

  await withFreshServer(async (ctx) => {
    await test("integration: get_metrics returns complete data", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      // Create a session
      await client.send({ type: "create_session", sessionId: "metrics-test" });
      await client.waitForMessage((msg) => msg.command === "create_session");
      client.clearMessages();

      await client.send({ type: "get_metrics" });

      const response = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.command === "get_metrics"
      );

      assert.strictEqual(response.success, true);
      assert.ok(typeof response.data?.sessionCount === "number");
      assert.ok(typeof response.data?.connectionCount === "number");
      assert.ok(typeof response.data?.totalCommandsExecuted === "number");
      assert.ok(typeof response.data?.commandsRejected === "object");
      assert.ok(typeof response.data?.doubleUnregisterErrors === "number");
      assert.ok(typeof response.data?.rateLimitUsage === "object");

      client.close();
    });
  });
}

async function testHealthCheck() {
  console.log("\n=== Health Check Tests ===\n");

  await withFreshServer(async (ctx) => {
    await test("integration: health_check returns healthy", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ type: "health_check" });

      const response = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.command === "health_check"
      );

      assert.strictEqual(response.success, true);
      assert.ok(typeof response.data?.healthy === "boolean");
      assert.ok(Array.isArray(response.data?.issues));

      client.close();
    });
  });
}

async function testGracefulShutdown() {
  console.log("\n=== Graceful Shutdown Tests ===\n");

  // Note: This test creates its own server because it shuts it down
  await test("integration: shutdown broadcasts to clients", async () => {
    const port = await getPort();
    const server = new PiServer();
    await server.start(port);
    await waitForServerReady(port);

    const client = new TestClient();
    await client.connect(port);
    client.clearMessages();

    // Initiate shutdown
    const shutdownPromise = server.stop(1000);

    // Wait for shutdown broadcast
    const broadcast = await client.waitForMessage((msg) => msg.type === "server_shutdown", 2000);

    assert.strictEqual(broadcast.type, "server_shutdown");
    assert.ok(broadcast.data?.reason, "Should have reason");
    assert.ok(typeof broadcast.data?.timeoutMs === "number", "Should have timeoutMs");

    await shutdownPromise;
    client.close();
  });
}

async function testCommandId() {
  console.log("\n=== Command ID Tests ===\n");

  await withFreshServer(async (ctx) => {
    await test("integration: response includes command id", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ type: "list_sessions", id: "test-id-123" });

      const response = await client.waitForMessage(
        (msg) => msg.type === "response" && msg.command === "list_sessions"
      );

      assert.strictEqual(response.id, "test-id-123");

      client.close();
    });
  });
}

async function testPortConflictHandling() {
  console.log("\n=== Port Conflict Tests ===\n");

  await test("integration: start fails with clear error on used port", async () => {
    const port = await getPort();
    const server1 = new PiServer();
    await server1.start(port);

    const server2 = new PiServer();
    let threw = false;
    try {
      await server2.start(port);
    } catch (error) {
      threw = true;
      assert(
        String(error).includes("Failed to start WebSocket server"),
        "Should include startup error context"
      );
    } finally {
      await server1.stop(1000);
    }

    assert.strictEqual(threw, true, "Second server should fail to start on same port");
  });
}

async function testConcurrentClients() {
  console.log("\n=== Concurrent Client Tests ===\n");

  await withFreshServer(async (ctx) => {
    await test("integration: handles concurrent clients", async () => {
      const clients = await Promise.all(
        Array.from({ length: 5 }, async () => {
          const c = new TestClient();
          await c.connect(ctx.port);
          c.clearMessages();
          return c;
        })
      );

      await Promise.all(clients.map((c) => c.send({ type: "list_sessions" })));

      const responses = await Promise.all(
        clients.map((c) =>
          c.waitForMessage((msg) => msg.type === "response" && msg.command === "list_sessions")
        )
      );

      for (const r of responses) {
        assert.strictEqual(r.success, true);
      }

      for (const c of clients) c.close();
    });
  });
}

async function testSessionEventSubscription() {
  console.log("\n=== Session Event Subscription Tests ===\n");

  await withFreshServer(async (ctx) => {
    await test("integration: broadcasts session events only to subscribers", async () => {
      const clientA = new TestClient();
      const clientB = new TestClient();
      await clientA.connect(ctx.port);
      await clientB.connect(ctx.port);
      clientA.clearMessages();
      clientB.clearMessages();

      await clientA.send({ type: "create_session", sessionId: "evt-1" });
      await clientA.waitForMessage((msg) => msg.command === "create_session");

      await clientA.send({ type: "switch_session", sessionId: "evt-1" });
      await clientA.waitForMessage((msg) => msg.command === "switch_session");

      // Inject a synthetic event through internal manager to test subscription filtering.
      (ctx.server.getSessionManager() as any).broadcastEvent("evt-1", { type: "test_event" });

      const eventA = await clientA.waitForMessage((msg) => msg.type === "event", 2000);
      assert.strictEqual((eventA as any).sessionId, "evt-1");

      // clientB is not subscribed to evt-1; should not receive event
      await sleep(300);
      const bEvents = clientB.getMessages().filter((m) => m.type === "event");
      assert.strictEqual(
        bEvents.length,
        0,
        "Unsubscribed client should not receive session events"
      );

      await clientA.send({ type: "delete_session", sessionId: "evt-1" });
      clientA.close();
      clientB.close();
    });
  });
}

async function testRateLimitingUnderLoad() {
  console.log("\n=== Rate Limiting Tests ===\n");

  await withFreshServer(async (ctx) => {
    await test("integration: enforces rate limit under load", async () => {
      const client = new TestClient();
      await client.connect(ctx.port);
      client.clearMessages();

      await client.send({ type: "create_session", sessionId: "rl-1" });
      await client.waitForMessage((msg) => msg.command === "create_session");
      client.clearMessages();

      for (let i = 0; i < 120; i++) {
        await client.send({ type: "get_state", sessionId: "rl-1", id: `r${i}` });
      }

      let gotRateLimit = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          const msg = await client.waitForMessage((m) => m.type === "response", 250);
          if (!msg.success && String(msg.error).includes("Rate limit")) {
            gotRateLimit = true;
            break;
          }
        } catch {
          // ignore polling timeout
        }
      }

      assert.strictEqual(gotRateLimit, true, "Expected at least one rate-limit rejection");

      await client.send({ type: "delete_session", sessionId: "rl-1" });
      client.close();
    });
  });
}

async function testStdioTransport() {
  console.log("\n=== Stdio Transport Tests ===\n");

  await test("integration: stdio accepts commands and returns responses", async () => {
    const port = await getPort();
    const child = spawn("node", ["dist/server.js"], {
      cwd: process.cwd(),
      env: { ...process.env, PI_SERVER_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const stdoutLines = readline.createInterface({ input: child.stdout! });

      const ready = await waitForJsonLine(stdoutLines, (obj) => obj.type === "server_ready", 8000);
      assert.strictEqual(ready.type, "server_ready");

      child.stdin!.write(JSON.stringify({ id: "stdio-1", type: "list_sessions" }) + "\n");

      const response = await waitForJsonLine(
        stdoutLines,
        (obj) => obj.type === "response" && obj.id === "stdio-1",
        8000
      );

      assert.strictEqual(response.success, true);
    } finally {
      child.kill("SIGTERM");
    }
  });

  await test("integration: stdio enforces byte-size limits for multibyte payloads", async () => {
    const port = await getPort();
    const child = spawn("node", ["dist/server.js"], {
      cwd: process.cwd(),
      env: { ...process.env, PI_SERVER_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const stdoutLines = readline.createInterface({ input: child.stdout! });
      await waitForJsonLine(stdoutLines, (obj) => obj.type === "server_ready", 8000);

      const oversizedMultibyte = "😀".repeat(2_800_000);
      child.stdin!.write(
        JSON.stringify({
          id: "stdio-byte-limit",
          type: "list_sessions",
          payload: oversizedMultibyte,
        }) + "\n"
      );

      const response = await waitForJsonLine(
        stdoutLines,
        (obj) =>
          obj.type === "response" &&
          obj.success === false &&
          typeof obj.error === "string" &&
          (obj.error.includes("size") || obj.error.includes("limit")),
        12000
      );

      assert.strictEqual(response.success, false);
    } finally {
      child.kill("SIGTERM");
    }
  });
}

// =============================================================================
// RUN ALL TESTS
// =============================================================================

async function main() {
  console.log("🧪 pi-server Integration Tests\n");
  console.log("Testing WebSocket wire protocol...\n");

  try {
    await testServerReady();
    await testCommandResponse();
    await testBroadcasts();
    await testMessageSize();
    await testConnectionLimit();
    await testMetrics();
    await testHealthCheck();
    await testCommandId();
    await testGracefulShutdown();
    await testPortConflictHandling();
    await testConcurrentClients();
    await testSessionEventSubscription();
    await testRateLimitingUnderLoad();
    await testStdioTransport();

    console.log("\n" + "=".repeat(50));
    console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);

    if (testsFailed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error("Test suite error:", err);
    process.exit(1);
  }
}

main();
