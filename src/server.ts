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

const VERSION = "0.1.0";
const DEFAULT_PORT = 3141;

// ============================================================================
// SERVER
// ============================================================================

export class PiServer {
  private sessionManager = new PiSessionManager();
  private wss: WebSocketServer | null = null;
  private stdinSubscribers = new Set<Subscriber>();

  async start(port: number = DEFAULT_PORT): Promise<void> {
    // Start WebSocket server
    this.wss = new WebSocketServer({ port });
    this.setupWebSocket(this.wss);

    // Setup stdio transport
    this.setupStdio();

    // Broadcast server_ready
    const readyEvent: RpcBroadcast = {
      type: "server_ready",
      data: { version: VERSION, transports: ["websocket", "stdio"] },
    };
    this.sessionManager.broadcast(JSON.stringify(readyEvent));

    console.error(`pi-app-server v${VERSION} listening on port ${port} and stdio`);
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close();
    }
  }

  // ==========================================================================
  // WEBSOCKET TRANSPORT
  // ==========================================================================

  private setupWebSocket(wss: WebSocketServer): void {
    wss.on("connection", (ws: WebSocket) => {
      const subscriber: Subscriber = {
        send: (data: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        },
        subscribedSessions: new Set(),
      };

      this.sessionManager.addSubscriber(subscriber);

      ws.on("message", async (data: Buffer) => {
        try {
          const command: RpcCommand = JSON.parse(data.toString());
          await this.handleCommand(command, subscriber, (response: RpcResponse) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(response));
            }
          });
        } catch (error) {
          const errorResponse: RpcResponse = {
            type: "response",
            command: "unknown",
            success: false,
            error: error instanceof Error ? error.message : "Invalid JSON",
          };
          ws.send(JSON.stringify(errorResponse));
        }
      });

      ws.on("close", () => {
        this.sessionManager.removeSubscriber(subscriber);
      });

      ws.on("error", () => {
        this.sessionManager.removeSubscriber(subscriber);
      });
    });
  }

  // ==========================================================================
  // STDIO TRANSPORT
  // ==========================================================================

  private setupStdio(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    const subscriber: Subscriber = {
      send: (data: string) => {
        process.stdout.write(data + "\n");
      },
      subscribedSessions: new Set(),
    };

    this.sessionManager.addSubscriber(subscriber);
    this.stdinSubscribers.add(subscriber);

    rl.on("line", async (line: string) => {
      try {
        const command: RpcCommand = JSON.parse(line);
        await this.handleCommand(command, subscriber, (response: RpcResponse) => {
          process.stdout.write(JSON.stringify(response) + "\n");
        });
      } catch (error) {
        const errorResponse: RpcResponse = {
          type: "response",
          command: "unknown",
          success: false,
          error: error instanceof Error ? error.message : "Invalid JSON",
        };
        process.stdout.write(JSON.stringify(errorResponse) + "\n");
      }
    });

    rl.on("close", () => {
      this.sessionManager.removeSubscriber(subscriber);
      this.stdinSubscribers.delete(subscriber);
    });
  }

  // ==========================================================================
  // COMMAND HANDLING
  // ==========================================================================

  private async handleCommand(
    command: RpcCommand,
    subscriber: Subscriber,
    respond: (response: RpcResponse) => void
  ): Promise<void> {
    // Handle subscription commands
    if (command.type === "switch_session") {
      const sessionId = (command as any).sessionId;
      if (sessionId) {
        this.sessionManager.subscribeToSession(subscriber, sessionId);
      }
    }

    // Execute command
    const response = await this.sessionManager.executeCommand(command);
    respond(response);

    // Broadcast session lifecycle events
    if (command.type === "create_session" && response.success) {
      const broadcast: RpcBroadcast = {
        type: "session_created",
        data: {
          sessionId: (response as any).data.sessionId,
          sessionInfo: (response as any).data.sessionInfo,
        },
      };
      this.sessionManager.broadcast(JSON.stringify(broadcast));
    } else if (command.type === "delete_session" && response.success) {
      const broadcast: RpcBroadcast = {
        type: "session_deleted",
        data: { sessionId: (command as any).sessionId },
      };
      this.sessionManager.broadcast(JSON.stringify(broadcast));
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const port = parseInt(process.env.PI_SERVER_PORT ?? String(DEFAULT_PORT), 10);
  const server = new PiServer();
  await server.start(port);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
