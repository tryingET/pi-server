/**
 * Integration tests for pi-server.
 *
 * Tests the actual WebSocket wire protocol.
 * Run with: node --experimental-vm-modules dist/test-integration.js
 *
 * Requires: pi-coding-agent (for real session creation)
 */

import assert from "assert";
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
async function withFreshServer(
  fn: (ctx: TestContext) => Promise<void>
): Promise<void> {
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
// CLEANUP HELPER
// =============================================================================

/**
 * Clean up all sessions on a server.
 */
async function cleanupAllSessions(client: TestClient): Promise<void> {
  await client.send({ type: "list_sessions" });
  const response = await client.waitForMessage(
    (msg) => msg.type === "response" && msg.command === "list_sessions"
  );
  for (const session of response.data?.sessions || []) {
    const sid = (session as { sessionId: string }).sessionId;
    await client.send({ type: "delete_session", sessionId: sid });
    await client.waitForMessage((msg) => msg.command === "delete_session");
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

      const readyMsg = await client.waitForMessage(
        (msg) => msg.type === "server_ready",
        2000
      );

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

      const readyMsg = await client.waitForMessage(
        (msg) => msg.type === "server_ready"
      );

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
      const broadcast = await client.waitForMessage(
        (msg) => msg.type === "session_created"
      );

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
      const broadcast = await client.waitForMessage(
        (msg) => msg.type === "session_deleted"
      );

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
    const broadcast = await client.waitForMessage(
      (msg) => msg.type === "server_shutdown",
      2000
    );

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
