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
import { type AuthProvider, type AuthContext, AllowAllAuthProvider } from "./auth.js";
import {
  MetricsEmitter,
  type MetricsSink,
  NoOpSink,
  MemorySink,
  CompositeSink,
  MetricNames,
  ThresholdAlertSink,
  type ThresholdConfig,
  type Alert,
} from "./metrics-index.js";
import { type Logger, ConsoleLogger, type LogLevel } from "./logger-index.js";

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

/** Stdio backpressure threshold (256KB). Beyond this, we start dropping non-critical messages. */
const _STDIO_BACKPRESSURE_THRESHOLD_BYTES = 256 * 1024;

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
  const { isCritical = false } = options;

  if (ws.readyState !== WebSocket.OPEN) {
    return { ok: false, reason: "closed" };
  }

  const buffered = ws.bufferedAmount;

  // Critical backpressure: close connection to prevent OOM
  if (buffered > BACKPRESSURE_CRITICAL_BYTES) {
    try {
      ws.close(1011, "Server overloaded - backpressure critical");
    } catch {
      // Ignore close errors
    }
    return { ok: false, reason: "backpressure" };
  }

  // Mild backpressure: drop non-critical messages
  if (buffered > BACKPRESSURE_THRESHOLD_BYTES && !isCritical) {
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
 * Stdio state for backpressure tracking.
 */
interface StdioState {
  /** Whether stdout has backpressure (last write returned false). */
  hasBackpressure: boolean;
  /** Count of dropped messages due to backpressure. */
  droppedCount: number;
  /** Whether drain handler is registered. */
  drainHandlerRegistered: boolean;
}

/**
 * Backpressure-aware stdio send.
 *
 * - Returns true if sent successfully
 * - Returns false if dropped due to backpressure
 * - Critical messages are always attempted
 */
function sendWithStdioBackpressure(
  data: string,
  state: StdioState,
  options: { isCritical?: boolean } = {}
): boolean {
  const { isCritical = false } = options;

  try {
    const canWrite = process.stdout.write(data + "\n");

    if (!canWrite) {
      state.hasBackpressure = true;

      // Register drain handler if not already registered
      if (!state.drainHandlerRegistered) {
        state.drainHandlerRegistered = true;
        process.stdout.once("drain", () => {
          state.hasBackpressure = false;
        });
      }
    }

    return true;
  } catch (error) {
    // If write throws, stdout is broken
    if (isCritical) {
      // For critical messages, try to log to stderr as fallback
      console.error(`[stdio] Critical message failed:`, error);
    }
    return false;
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

export interface PiServerOptions {
  /** Authentication provider (default: AllowAllAuthProvider) */
  authProvider?: AuthProvider;
  /** Metrics sink(s) for observability. Can be a single sink or CompositeSink. */
  metricsSink?: MetricsSink;
  /** Include MemorySink automatically for get_metrics command (default: true) */
  includeMemoryMetrics?: boolean;
  /** Logger for structured logging (default: ConsoleLogger with 'info' level) */
  logger?: Logger;
  /** Log level for default ConsoleLogger (ignored if logger is provided) */
  logLevel?: LogLevel;
  /** Alert thresholds for automatic monitoring (default: built-in thresholds) */
  alertThresholds?: Record<string, ThresholdConfig>;
  /** Called when an alert fires (default: console logging) */
  onAlert?: (alert: Alert) => void | Promise<void>;
  /** Called when an alert clears (optional) */
  onAlertClear?: (alert: Alert) => void | Promise<void>;
}

export class PiServer {
  private sessionManager = new PiSessionManager();
  private wss: WebSocketServer | null = null;
  private stdinInterface: readline.Interface | null = null;
  private authProvider: AuthProvider;
  private serverStartTime = Date.now();
  private metrics: MetricsEmitter;
  private logger: Logger;
  /** Memory sink for get_metrics command (if included) */
  private memorySink: MemorySink | null = null;
  /** Stdio backpressure state */
  private stdioState: StdioState = {
    hasBackpressure: false,
    droppedCount: 0,
    drainHandlerRegistered: false,
  };

  constructor(options: PiServerOptions = {}) {
    this.authProvider = options.authProvider ?? new AllowAllAuthProvider();

    // Setup logger
    this.logger =
      options.logger ??
      new ConsoleLogger({
        level: options.logLevel ?? "info",
        component: "pi-server",
      });

    // Default alert thresholds for built-in monitoring
    const defaultAlertThresholds: Record<string, ThresholdConfig> = {
      [MetricNames.RATE_LIMIT_GENERATION_COUNTER]: {
        info: 1e12, // 1 trillion - start paying attention
        warn: 1e14, // 100 trillion - concerning
        critical: 1e15, // 1 quadrillion - action needed
      },
    };

    // Setup metrics system
    const includeMemory = options.includeMemoryMetrics ?? true;
    const sinks: MetricsSink[] = [];

    if (options.metricsSink) {
      sinks.push(options.metricsSink);
    }

    if (includeMemory) {
      this.memorySink = new MemorySink({ maxEvents: 1000 });
      sinks.push(this.memorySink);
    }

    // Create base composite sink (or no-op if no sinks)
    const baseSink = sinks.length > 0 ? new CompositeSink(sinks) : new NoOpSink();

    // Wrap with ThresholdAlertSink for monitoring
    const alertThresholds = options.alertThresholds ?? defaultAlertThresholds;
    const onAlert =
      options.onAlert ??
      ((alert: Alert) => {
        const levelStr = `[${alert.level.toUpperCase()}]`;
        if (alert.level === "critical") {
          console.error(`${levelStr} ${alert.message}`);
        } else {
          console.log(`${levelStr} ${alert.message}`);
        }
      });

    const alertSink = new ThresholdAlertSink({
      sink: baseSink,
      thresholds: alertThresholds,
      onAlert,
      onClear: options.onAlertClear,
      maxAlertStates: 1000,
    });

    this.metrics = new MetricsEmitter({ sink: alertSink });

    // Wire metrics to governor for rate limit monitoring
    this.sessionManager.getGovernor().setMetrics(this.metrics);

    // Wire memory metrics provider to session manager
    if (this.memorySink) {
      this.sessionManager.setMemoryMetricsProvider(() => this.memorySink!.getMetrics());
    }
  }

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

    // Start periodic rate limit timestamp cleanup (every 5 minutes)
    this.sessionManager.getGovernor().startPeriodicCleanup(300000);

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

    // Record server start metric
    this.metrics.event(MetricNames.EVENT_SESSION_CREATED, { event: "server_ready" });

    this.logger.info("Server started", {
      version: SERVER_VERSION,
      protocol: PROTOCOL_VERSION,
      port,
      transports: ["websocket", "stdio"],
    });
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
   * Get metrics emitter for external access.
   */
  getMetrics(): MetricsEmitter {
    return this.metrics;
  }

  /**
   * Get logger for external access.
   */
  getLogger(): Logger {
    return this.logger;
  }

  /**
   * Get memory sink metrics (for get_metrics command).
   * Returns undefined if includeMemoryMetrics was false.
   */
  getMemoryMetrics(): Record<string, unknown> | undefined {
    return this.memorySink?.getMetrics();
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

    this.logger.info("Graceful shutdown initiated");

    // ADR-0007: Stop periodic cleanup
    this.sessionManager.stopSessionCleanup();

    // Stop periodic rate limit timestamp cleanup
    this.sessionManager.getGovernor().stopPeriodicCleanup();

    // Dispose auth provider
    if (this.authProvider.dispose) {
      try {
        await Promise.resolve(this.authProvider.dispose());
      } catch (error) {
        this.logger.logError(
          "Auth provider dispose failed",
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    // Stop accepting new WebSocket connections
    if (this.wss) {
      this.wss.close(() => {
        this.logger.debug("WebSocket server closed (no new connections)");
      });
    }

    // Close stdin to stop accepting new commands
    if (this.stdinInterface) {
      this.stdinInterface.close();
      this.stdinInterface = null;
      this.logger.debug("Stdin closed");
    }

    // Initiate session manager shutdown (broadcasts notification, drains commands)
    const result = await this.sessionManager.initiateShutdown(timeoutMs);

    if (result.timedOut) {
      this.logger.warn("Shutdown timed out", {
        timeoutMs,
        drained: result.drained,
        pending: this.sessionManager.getInFlightCount(),
      });
    } else {
      this.logger.info("All in-flight commands completed", { count: result.drained });
    }

    // Close all remaining WebSocket connections
    if (this.wss) {
      const clients = [...this.wss.clients];
      this.logger.info("Closing WebSocket connections", { count: clients.length });
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
    this.logger.info("Sessions disposed", {
      disposed: disposeResult.disposed,
      failed: disposeResult.failed,
    });

    // Record uptime before final flush so buffered sinks include it
    const uptimeMs = Date.now() - this.serverStartTime;
    this.metrics.gauge(MetricNames.SESSION_LIFETIME_SECONDS, Math.floor(uptimeMs / 1000));

    // Flush metrics before shutdown
    await this.metrics.flush();

    this.logger.info("Shutdown complete", { uptimeMs });
  }

  // ==========================================================================
  // WEBSOCKET TRANSPORT
  // ==========================================================================

  private setupWebSocket(wss: WebSocketServer): void {
    wss.on("connection", async (ws: WebSocket, request: any) => {
      // Check connection limit
      const connResult = this.sessionManager.getGovernor().canAcceptConnection();
      if (!connResult.allowed) {
        this.logger.warn("Connection rejected", { reason: connResult.reason });
        try {
          ws.close(1013, connResult.reason);
        } catch {
          // Ignore close errors
        }
        return;
      }

      // Authenticate connection
      const authContext: AuthContext = {
        request,
        websocket: {
          remoteAddress: request.socket?.remoteAddress,
          secure: request.socket?.encrypted ?? false,
        },
        serverStartTime: this.serverStartTime,
        connectionCount: this.sessionManager.getGovernor().getConnectionCount(),
      };

      const authResult = await Promise.resolve(this.authProvider.authenticate(authContext));
      if (!authResult.allowed) {
        this.logger.warn("Authentication failed", { reason: authResult.reason });
        try {
          ws.close(1008, authResult.reason); // 1008 = Policy Violation
        } catch {
          // Ignore close errors
        }
        return;
      }

      // Register connection
      this.sessionManager.getGovernor().registerConnection();

      // Record connection metric
      this.metrics.counter(MetricNames.CONNECTIONS_TOTAL, 1);
      this.metrics.gauge(
        MetricNames.CONNECTIONS_ACTIVE,
        this.sessionManager.getGovernor().getConnectionCount()
      );

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
        // Update connection metrics
        this.metrics.gauge(
          MetricNames.CONNECTIONS_ACTIVE,
          this.sessionManager.getGovernor().getConnectionCount()
        );
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
        // Use backpressure-aware write (non-critical - broadcasts can be dropped)
        if (!sendWithStdioBackpressure(data, this.stdioState, { isCritical: false })) {
          this.stdioState.droppedCount++;
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
        // Error responses are critical
        sendWithStdioBackpressure(JSON.stringify(errorResponse), this.stdioState, {
          isCritical: true,
        });
        return;
      }

      try {
        const command: RpcCommand = JSON.parse(line);
        await this.handleCommand(command, subscriber, (response: RpcResponse) => {
          // Command responses are critical
          sendWithStdioBackpressure(JSON.stringify(response), this.stdioState, {
            isCritical: true,
          });
        });
      } catch (error) {
        const errorResponse: RpcResponse = {
          type: "response",
          command: "unknown",
          success: false,
          error: error instanceof Error ? error.message : "Invalid JSON",
        };
        sendWithStdioBackpressure(JSON.stringify(errorResponse), this.stdioState, {
          isCritical: true,
        });
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
