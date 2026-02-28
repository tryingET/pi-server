#!/usr/bin/env node
/**
 * pi-app-server - Session multiplexer for pi-coding-agent
 *
 * Exposes N independent AgentSessions through dual transports:
 * - WebSocket on port 3141
 * - stdio (JSON lines)
 *
 * The protocol IS the architecture.
 */

import * as readline from "readline";
import { WebSocketServer, WebSocket } from "ws";
import { PiSessionManager } from "./session-manager.js";
import type { RpcCommand, RpcResponse, Subscriber, RpcBroadcast } from "./types.js";
import { getSessionId as getSessionIdFromCmd, isCreateSessionResponse } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "1.0.0";
const DEFAULT_PORT = 3141;

/** Default graceful shutdown timeout (30 seconds) */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30000;

/** WebSocket backpressure threshold (64KB). Beyond this, we start dropping non-critical messages. */
const BACKPRESSURE_THRESHOLD_BYTES = 64 * 1024;

/** WebSocket critical backpressure threshold (1MB). Beyond this, we close the connection. */
const BACKPRESSURE_CRITICAL_BYTES = 1024 * 1024;

/** WebSocket heartbeat interval (30 seconds). */
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

/** WebSocket heartbeat timeout (10 seconds). If no pong received, close connection. */
const HEARTBEAT_TIMEOUT_MS = 10 * 1000;

/**
 * WebSocket connection state for heartbeat tracking.
 */
interface WebSocketConnectionState {
  /** Whether we're waiting for a pong response. */
  waitingForPong: boolean;
  /** Timestamp of last pong received. */
  lastPongAt: number;
  /** Heartbeat interval timer. */
  heartbeatTimer: NodeJS.Timeout | null;
  /** Timeout timer for missing pong. */
  pongTimeoutTimer: NodeJS.Timeout | null;
  /** Whether the connection has been cleaned up (prevents use-after-free in async callbacks). */
  cleanedUp: boolean;
}

/**
 * Send result types for backpressure-aware WebSocket sends.
 */
type SendResult =
  | { ok: true }
  | { ok: false; reason: "backpressure" | "closed" | "error"; error?: Error };

/**
 * Backpressure-aware WebSocket send.
 *
 * - Returns { ok: true } if sent successfully
 * - Returns { ok: false, reason: "backpressure" } if message dropped due to backpressure
 * - Returns { ok: false, reason: "closed" } if connection not open
 * - Returns { ok: false, reason: "error" } if send threw
 *
 * For critical messages (isCritical: true), we attempt send even under mild backpressure.
 * Under critical backpressure (>1MB), connection is closed to prevent OOM.
 */
function sendWithBackpressure(
  ws: WebSocket,
  data: string,
  options: { isCritical?: boolean } = {}
): SendResult {
  if (ws.readyState !== WebSocket.OPEN) {
    return { ok: false, reason: "closed" };
  }

  const bufferedAmount = ws.bufferedAmount;

  // Critical backpressure: close connection to prevent OOM
  if (bufferedAmount > BACKPRESSURE_CRITICAL_BYTES) {
    console.error(
      `[WebSocket] Critical backpressure (${bufferedAmount} bytes), closing connection`
    );
    try {
      ws.close(1013, "Backpressure limit exceeded");
    } catch {
      // Ignore close errors
    }
    return { ok: false, reason: "backpressure" };
  }

  // Mild backpressure: drop non-critical messages
  if (bufferedAmount > BACKPRESSURE_THRESHOLD_BYTES && !options.isCritical) {
    console.error(
      `[WebSocket] Backpressure warning (${bufferedAmount} bytes), dropping non-critical message`
    );
    return { ok: false, reason: "backpressure" };
  }

  try {
    ws.send(data);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Start heartbeat for a WebSocket connection.
 * Sends periodic pings and closes connection if pong not received.
 */
function startHeartbeat(ws: WebSocket, state: WebSocketConnectionState): void {
  state.lastPongAt = Date.now();
  state.waitingForPong = false;
  state.cleanedUp = false;

  state.heartbeatTimer = setInterval(() => {
    // Check cleanup flag first to prevent use-after-free
    if (state.cleanedUp || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat(state);
      return;
    }

    // If still waiting for previous pong, close connection
    if (state.waitingForPong) {
      const elapsed = Date.now() - state.lastPongAt;
      console.error(`[WebSocket] No pong received after ${elapsed}ms, closing connection`);
      stopHeartbeat(state);
      try {
        ws.close(1001, "Heartbeat timeout");
      } catch {
        // Ignore close errors
      }
      return;
    }

    // Send ping
    state.waitingForPong = true;
    try {
      ws.ping();
    } catch {
      // Ping failed, connection likely dead
      stopHeartbeat(state);
    }

    // Set pong timeout
    state.pongTimeoutTimer = setTimeout(() => {
      // Check cleanup flag first to prevent race with cleanupConnection
      if (state.cleanedUp) return;

      if (state.waitingForPong && ws.readyState === WebSocket.OPEN) {
        console.error(
          `[WebSocket] Pong timeout after ${HEARTBEAT_TIMEOUT_MS}ms, closing connection`
        );
        stopHeartbeat(state);
        try {
          ws.close(1001, "Heartbeat timeout");
        } catch {
          // Ignore close errors
        }
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop heartbeat timers for a WebSocket connection.
 */
function stopHeartbeat(state: WebSocketConnectionState): void {
  // Set cleanedUp flag first to prevent any in-flight callbacks from acting
  state.cleanedUp = true;
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  if (state.pongTimeoutTimer) {
    clearTimeout(state.pongTimeoutTimer);
    state.pongTimeoutTimer = null;
  }
  state.waitingForPong = false;
}

// ============================================================================
// SERVER
// ============================================================================

export class PiServer {
  private sessionManager = new PiSessionManager();
  private wss: WebSocketServer | null = null;
  private stdinInterface: readline.Interface | null = null;

  async start(port: number = DEFAULT_PORT): Promise<void> {
    // Start WebSocket server
    this.wss = new WebSocketServer({ port });
    this.setupWebSocket(this.wss);

    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        this.wss?.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        this.wss?.off("listening", onListening);
        reject(error);
      };

      this.wss?.once("listening", onListening);
      this.wss?.once("error", onError);
    }).catch((error) => {
      throw new Error(
        `Failed to start WebSocket server on port ${port}: ${error instanceof Error ? error.message : String(error)}`
      );
    });

    // Setup stdio transport
    this.stdinInterface = this.setupStdio();

    // ADR-0007: Start periodic session metadata cleanup (every hour)
    this.sessionManager.startSessionCleanup(3600000);

    // Broadcast server_ready
    const readyEvent: RpcBroadcast = {
      type: "server_ready",
      data: {
        serverVersion: SERVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        transports: ["websocket", "stdio"],
      },
    };
    this.sessionManager.broadcast(JSON.stringify(readyEvent));

    console.error(
      `pi-app-server v${SERVER_VERSION} (protocol v${PROTOCOL_VERSION}) listening on port ${port} and stdio`
    );
  }

  /**
   * Check if server is shutting down.
   */
  isInShutdown(): boolean {
    return this.sessionManager.isInShutdown();
  }

  /**
   * Get session manager for external access.
   */
  getSessionManager(): PiSessionManager {
    return this.sessionManager;
  }

  /**
   * Graceful shutdown.
   * 1. Stop accepting new connections
   * 2. Broadcast shutdown notification
   * 3. Drain in-flight commands
   * 4. Close all WebSocket connections
   * 5. Close stdin
   * 6. Dispose all sessions
   */
  async stop(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
    }

    // Check via session manager (single source of truth)
    if (this.sessionManager.isInShutdown()) {
      return; // Already shutting down
    }

    console.error("[shutdown] Initiating graceful shutdown...");

    // ADR-0007: Stop periodic cleanup
    this.sessionManager.stopSessionCleanup();

    // Stop accepting new WebSocket connections
    if (this.wss) {
      this.wss.close(() => {
        console.error("[shutdown] WebSocket server closed (no new connections)");
      });
    }

    // Close stdin to stop accepting new commands
    if (this.stdinInterface) {
      this.stdinInterface.close();
      this.stdinInterface = null;
      console.error("[shutdown] Stdin closed");
    }

    // Initiate session manager shutdown (broadcasts notification, drains commands)
    const result = await this.sessionManager.initiateShutdown(timeoutMs);

    if (result.timedOut) {
      console.error(
        `[shutdown] Timed out after ${timeoutMs}ms, ${result.drained} commands drained, ${this.sessionManager.getInFlightCount()} still pending`
      );
    } else {
      console.error(`[shutdown] All ${result.drained} in-flight commands completed`);
    }

    // Close all remaining WebSocket connections
    if (this.wss) {
      const clients = [...this.wss.clients];
      console.error(`[shutdown] Closing ${clients.length} WebSocket connections...`);
      for (const ws of clients) {
        try {
          ws.close(1001, "Server shutting down");
        } catch {
          // Ignore close errors
        }
      }
    }

    // Dispose all sessions
    const disposeResult = this.sessionManager.disposeAllSessions();
    console.error(
      `[shutdown] Disposed ${disposeResult.disposed} sessions (${disposeResult.failed} failed)`
    );

    console.error("[shutdown] Complete");
  }

  // ==========================================================================
  // WEBSOCKET TRANSPORT
  // ==========================================================================

  private setupWebSocket(wss: WebSocketServer): void {
    wss.on("connection", (ws: WebSocket) => {
      // Check connection limit
      const connResult = this.sessionManager.getGovernor().canAcceptConnection();
      if (!connResult.allowed) {
        console.error(`[WebSocket] Connection rejected: ${connResult.reason}`);
        try {
          ws.close(1013, connResult.reason);
        } catch {
          // Ignore close errors
        }
        return;
      }

      // Register connection
      this.sessionManager.getGovernor().registerConnection();

      // Initialize heartbeat state
      const heartbeatState: WebSocketConnectionState = {
        waitingForPong: false,
        lastPongAt: Date.now(),
        heartbeatTimer: null,
        pongTimeoutTimer: null,
        cleanedUp: false,
      };

      const subscriber: Subscriber = {
        send: (data: string) => {
          // Use backpressure-aware send for broadcast messages (non-critical)
          sendWithBackpressure(ws, data, { isCritical: false });
        },
        subscribedSessions: new Set(),
      };

      // Send server_ready to new connection (critical - must be delivered)
      const readyEvent: RpcBroadcast = {
        type: "server_ready",
        data: {
          serverVersion: SERVER_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          transports: ["websocket", "stdio"],
        },
      };
      sendWithBackpressure(ws, JSON.stringify(readyEvent), { isCritical: true });

      this.sessionManager.addSubscriber(subscriber);

      let cleanedUp = false;
      const cleanupConnection = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        stopHeartbeat(heartbeatState);
        this.sessionManager.removeSubscriber(subscriber);
        this.sessionManager.getGovernor().unregisterConnection();
      };

      // Start heartbeat monitoring
      startHeartbeat(ws, heartbeatState);

      // Handle pong responses
      ws.on("pong", () => {
        heartbeatState.waitingForPong = false;
        heartbeatState.lastPongAt = Date.now();
        if (heartbeatState.pongTimeoutTimer) {
          clearTimeout(heartbeatState.pongTimeoutTimer);
          heartbeatState.pongTimeoutTimer = null;
        }
      });

      ws.on("message", async (data: Buffer) => {
        // Check message size limit
        const sizeResult = this.sessionManager.getGovernor().canAcceptMessage(data.length);
        if (!sizeResult.allowed) {
          const errorResponse: RpcResponse = {
            type: "response",
            command: "unknown",
            success: false,
            error: sizeResult.reason,
          };
          // Error responses are critical - client needs to know why their message was rejected
          sendWithBackpressure(ws, JSON.stringify(errorResponse), { isCritical: true });
          return;
        }

        try {
          const command: RpcCommand = JSON.parse(data.toString());
          await this.handleCommand(command, subscriber, (response: RpcResponse) => {
            // Command responses are critical - client is waiting for them
            sendWithBackpressure(ws, JSON.stringify(response), { isCritical: true });
          });
        } catch (error) {
          const errorResponse: RpcResponse = {
            type: "response",
            command: "unknown",
            success: false,
            error: error instanceof Error ? error.message : "Invalid JSON",
          };
          // Parse error responses are critical
          sendWithBackpressure(ws, JSON.stringify(errorResponse), { isCritical: true });
        }
      });

      ws.on("close", () => {
        cleanupConnection();
      });

      ws.on("error", (error) => {
        console.error(`[WebSocket] Connection error:`, error);
        cleanupConnection();
      });
    });
  }

  // ==========================================================================
  // STDIO TRANSPORT
  // ==========================================================================

  private setupStdio(): readline.Interface {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    const subscriber: Subscriber = {
      send: (data: string) => {
        try {
          process.stdout.write(data + "\n");
        } catch (error) {
          console.error(`[stdio] Failed to write to stdout:`, error);
        }
      },
      subscribedSessions: new Set(),
    };

    this.sessionManager.addSubscriber(subscriber);

    rl.on("line", async (line: string) => {
      // Check message size limit (bytes, not UTF-16 code units)
      const messageBytes = Buffer.byteLength(line, "utf8");
      const sizeResult = this.sessionManager.getGovernor().canAcceptMessage(messageBytes);
      if (!sizeResult.allowed) {
        const errorResponse: RpcResponse = {
          type: "response",
          command: "unknown",
          success: false,
          error: sizeResult.reason,
        };
        try {
          process.stdout.write(JSON.stringify(errorResponse) + "\n");
        } catch {
          // Stdout broken
        }
        return;
      }

      try {
        const command: RpcCommand = JSON.parse(line);
        await this.handleCommand(command, subscriber, (response: RpcResponse) => {
          try {
            process.stdout.write(JSON.stringify(response) + "\n");
          } catch (error) {
            console.error(`[stdio] Failed to write response:`, error);
          }
        });
      } catch (error) {
        const errorResponse: RpcResponse = {
          type: "response",
          command: "unknown",
          success: false,
          error: error instanceof Error ? error.message : "Invalid JSON",
        };
        try {
          process.stdout.write(JSON.stringify(errorResponse) + "\n");
        } catch {
          // Stdout broken, nothing we can do
        }
      }
    });

    rl.on("close", () => {
      this.sessionManager.removeSubscriber(subscriber);
    });

    return rl;
  }

  // ==========================================================================
  // COMMAND HANDLING
  // ==========================================================================

  private async handleCommand(
    command: RpcCommand,
    subscriber: Subscriber,
    respond: (response: RpcResponse) => void
  ): Promise<void> {
    // Execute command
    const response = await this.sessionManager.executeCommand(command);
    respond(response);

    // Handle subscription AFTER successful switch_session
    if (command.type === "switch_session" && response.success) {
      const sessionId = getSessionIdFromCmd(command);
      if (sessionId) {
        this.sessionManager.subscribeToSession(subscriber, sessionId);
      }
    }

    // Broadcast session lifecycle events
    if (command.type === "create_session" && isCreateSessionResponse(response)) {
      const broadcast: RpcBroadcast = {
        type: "session_created",
        data: {
          sessionId: response.data.sessionId,
          sessionInfo: response.data.sessionInfo,
        },
      };
      this.sessionManager.broadcast(JSON.stringify(broadcast));
    } else if (command.type === "delete_session" && response.success) {
      const broadcast: RpcBroadcast = {
        type: "session_deleted",
        data: { sessionId: getSessionIdFromCmd(command)! },
      };
      this.sessionManager.broadcast(JSON.stringify(broadcast));
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  // Parse port with validation
  const portEnv = process.env.PI_SERVER_PORT;
  const port = portEnv ? parseInt(portEnv, 10) : DEFAULT_PORT;

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid PI_SERVER_PORT: "${portEnv}". Must be 1-65535.`);
    process.exit(1);
    return; // TypeScript needs this
  }

  const server = new PiServer();
  await server.start(port);

  // Graceful shutdown handlers
  const handleShutdown = async (signal: string) => {
    console.error(`\n[${signal}] Received, initiating shutdown...`);
    await server.stop(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    process.exit(0);
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
