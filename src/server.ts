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
import {
  getSessionId as getSessionIdFromCmd,
  isCreateSessionResponse,
} from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "1.0.0";
const DEFAULT_PORT = 3141;

/** Default graceful shutdown timeout (30 seconds) */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30000;

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
      console.error(`[shutdown] Timed out after ${timeoutMs}ms, ${result.drained} commands drained, ${this.sessionManager.getInFlightCount()} still pending`);
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
    console.error(`[shutdown] Disposed ${disposeResult.disposed} sessions (${disposeResult.failed} failed)`);

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

      const subscriber: Subscriber = {
        send: (data: string) => {
          // Check state immediately before send; if closed, silently skip
          // This is inherently racy but the race window is acceptable
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(data);
            } catch {
              // Send failed, subscriber will be cleaned up by close handler
            }
          }
        },
        subscribedSessions: new Set(),
      };

      // Send server_ready to new connection
      const readyEvent: RpcBroadcast = {
        type: "server_ready",
        data: {
          serverVersion: SERVER_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          transports: ["websocket", "stdio"],
        },
      };
      try {
        ws.send(JSON.stringify(readyEvent));
      } catch {
        // Send failed, connection will be cleaned up
      }

      this.sessionManager.addSubscriber(subscriber);

      let cleanedUp = false;
      const cleanupConnection = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        this.sessionManager.removeSubscriber(subscriber);
        this.sessionManager.getGovernor().unregisterConnection();
      };

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
          try {
            ws.send(JSON.stringify(errorResponse));
          } catch {
            // Error response send failed
          }
          return;
        }

        try {
          const command: RpcCommand = JSON.parse(data.toString());
          await this.handleCommand(command, subscriber, (response: RpcResponse) => {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify(response));
              } catch {
                // Response send failed
              }
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
            ws.send(JSON.stringify(errorResponse));
          } catch {
            // Error response send failed
          }
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
      // Check message size limit
      const sizeResult = this.sessionManager.getGovernor().canAcceptMessage(line.length);
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
