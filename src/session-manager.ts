/**
 * Session Manager - owns session lifecycle, command execution, and subscriber maps.
 *
 * Server commands handled here. Session commands delegated to command-router.
 * Extension UI requests tracked by ExtensionUIManager.
 */

import {
  type AgentSession,
  createAgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { SessionInfo, RpcCommand, RpcResponse, RpcEvent, Subscriber } from "./types.js";
import { getCommandId, getCommandType, getSessionId } from "./types.js";
import { routeSessionCommand } from "./command-router.js";
import { ExtensionUIManager } from "./extension-ui.js";
import { createServerUIContext } from "./server-ui-context.js";
import { validateCommand, formatValidationErrors } from "./validation.js";
import { ResourceGovernor, DEFAULT_CONFIG } from "./resource-governor.js";

/** Default timeout for session commands (5 minutes for LLM operations) */
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** Default graceful shutdown timeout (30 seconds) */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30 * 1000;

/** Short command timeout (30 seconds) */
const SHORT_COMMAND_TIMEOUT_MS = 30 * 1000;

/** Commands that should have shorter timeout */
const SHORT_TIMEOUT_COMMANDS = new Set([
  "get_state",
  "get_messages",
  "get_available_models",
  "get_commands",
  "get_skills",
  "get_tools",
  "list_session_files",
  "get_session_stats",
  "get_fork_messages",
  "get_last_assistant_text",
  "get_context_usage",
  "set_session_name",
]);

/**
 * Wrap a promise with a timeout.
 * Returns the promise result or throws on timeout.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, commandType: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command '${commandType}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export class PiSessionManager {
  private sessions = new Map<string, AgentSession>();
  private sessionCreatedAt = new Map<string, Date>();
  private subscribers = new Set<Subscriber>();
  private unsubscribers = new Map<string, () => void>();
  private governor: ResourceGovernor;

  // Shutdown state (single source of truth - server.ts delegates to this)
  private isShuttingDown = false;
  private inFlightCommands = new Set<Promise<unknown>>();

  // Extension UI request tracking
  private extensionUI = new ExtensionUIManager((sessionId: string, event: AgentSessionEvent) =>
    this.broadcastEvent(sessionId, event)
  );

  constructor(governor?: ResourceGovernor) {
    this.governor = governor ?? new ResourceGovernor(DEFAULT_CONFIG);
  }

  /**
   * Get the resource governor for external checks (e.g., message size).
   */
  getGovernor(): ResourceGovernor {
    return this.governor;
  }

  // ==========================================================================
  // SHUTDOWN MANAGEMENT
  // ==========================================================================

  /**
   * Check if the server is shutting down.
   */
  isInShutdown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Initiate graceful shutdown.
   * - Stops accepting new commands
   * - Broadcasts shutdown notification to all clients
   * - Returns promise that resolves when all in-flight commands complete or timeout
   * 
   * Idempotent: calling multiple times returns the same result.
   */
  async initiateShutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<{ drained: number; timedOut: boolean }> {
    // Idempotent check - only initiate once
    if (this.isShuttingDown) {
      // Return current state - how many commands are still in flight
      const remaining = this.inFlightCommands.size;
      return { drained: 0, timedOut: remaining > 0 };
    }
    
    this.isShuttingDown = true;

    // Broadcast shutdown notification
    const shutdownEvent = {
      type: "server_shutdown",
      data: { reason: "graceful_shutdown", timeoutMs },
    };
    this.broadcast(JSON.stringify(shutdownEvent));

    // Wait for in-flight commands with timeout
    const inFlightCount = this.inFlightCommands.size;
    
    if (inFlightCount === 0) {
      return { drained: 0, timedOut: false };
    }

    // Snapshot the current in-flight commands
    const snapshot = [...this.inFlightCommands];
    
    const drainPromise = Promise.allSettled(snapshot);
    
    const timeoutPromise = new Promise<{ drained: number; timedOut: boolean }>((resolve) => {
      setTimeout(() => {
        // Count how many from the original snapshot are still pending
        const stillPending = snapshot.filter((p) => this.inFlightCommands.has(p)).length;
        const drained = inFlightCount - stillPending;
        resolve({ drained, timedOut: true });
      }, timeoutMs);
    });

    const drainResult = new Promise<{ drained: number; timedOut: boolean }>((resolve) => {
      drainPromise.then(() => {
        resolve({ drained: inFlightCount, timedOut: false });
      });
    });

    return Promise.race([drainResult, timeoutPromise]);
  }

  /**
   * Dispose all sessions. Call after shutdown drain completes.
   */
  disposeAllSessions(): { disposed: number; failed: number } {
    let disposed = 0;
    let failed = 0;
    
    // Snapshot session IDs
    const sessionIds = [...this.sessions.keys()];
    
    for (const sessionId of sessionIds) {
      try {
        // Get session before removing
        const session = this.sessions.get(sessionId);
        
        // Remove from maps first
        this.sessions.delete(sessionId);
        this.sessionCreatedAt.delete(sessionId);
        
        // Unsubscribe
        const unsubscribe = this.unsubscribers.get(sessionId);
        if (unsubscribe) {
          this.unsubscribers.delete(sessionId);
          try {
            unsubscribe();
          } catch {
            // Ignore unsubscribe errors during disposal
          }
        }
        
        // Dispose session
        if (session) {
          try {
            session.dispose();
            disposed++;
          } catch {
            failed++;
          }
        }
      } catch {
        failed++;
      }
    }
    
    // Clear governor state
    this.governor.cleanupStaleData(new Set());
    
    return { disposed, failed };
  }

  /**
   * Get count of in-flight commands.
   */
  getInFlightCount(): number {
    return this.inFlightCommands.size;
  }

  /**
   * Track an in-flight command.
   * Uses unknown type to avoid unsafe casts.
   */
  private trackCommand<T>(promise: Promise<T>): Promise<T> {
    // Add to tracking set
    this.inFlightCommands.add(promise);
    
    // Remove from tracking when settled (success or failure)
    const cleanup = () => {
      this.inFlightCommands.delete(promise);
    };
    
    promise.then(cleanup, cleanup);
    
    return promise;
  }

  // ==========================================================================
  // SESSION LIFECYCLE
  // ==========================================================================

  async createSession(sessionId: string, cwd?: string): Promise<SessionInfo> {
    // Validate session ID
    const sessionIdError = this.governor.validateSessionId(sessionId);
    if (sessionIdError) {
      throw new Error(sessionIdError);
    }

    // Validate cwd if provided
    if (cwd) {
      const cwdError = this.governor.validateCwd(cwd);
      if (cwdError) {
        throw new Error(cwdError);
      }
    }

    // Check for duplicate (still possible race, but unlikely with valid IDs)
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    // Atomically reserve a session slot (prevents race conditions)
    if (!this.governor.tryReserveSessionSlot()) {
      throw new Error(`Session limit reached (${this.governor.getConfig().maxSessions} sessions)`);
    }

    try {
      const { session } = await createAgentSession({
        cwd: cwd ?? process.cwd(),
      });

      // Wire extension UI - this is the nexus intervention!
      // Without this, extension UI requests (select, confirm, input, etc.) hang.
      await session.bindExtensions({
        uiContext: createServerUIContext(sessionId, this.extensionUI, (sid, event) =>
          this.broadcastEvent(sid, event)
        ),
      });

      this.sessions.set(sessionId, session);
      this.sessionCreatedAt.set(sessionId, new Date());
      // Record heartbeat (session count already incremented by tryReserveSessionSlot)
      this.governor.recordHeartbeat(sessionId);

      // Subscribe to all events from this session
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        this.broadcastEvent(sessionId, event);
      });
      this.unsubscribers.set(sessionId, unsubscribe);

      return this.getSessionInfo(sessionId)!;
    } catch (error) {
      // Release the slot if session creation failed
      this.governor.releaseSessionSlot();
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Cancel any pending extension UI requests for this session
    this.extensionUI.cancelSessionRequests(sessionId);

    // Remove from maps first to prevent new operations
    this.sessions.delete(sessionId);
    this.sessionCreatedAt.delete(sessionId);
    this.governor.unregisterSession(sessionId);

    // Clean up stale governor data for this session
    this.governor.cleanupStaleData(new Set(this.sessions.keys()));

    // Unsubscribe from events
    const unsubscribe = this.unsubscribers.get(sessionId);
    if (unsubscribe) {
      this.unsubscribers.delete(sessionId);
      try {
        unsubscribe();
      } catch (error) {
        console.error(`[deleteSession] Failed to unsubscribe:`, error);
      }
    }

    // Dispose the session
    try {
      session.dispose();
    } catch (error) {
      console.error(`[deleteSession] Failed to dispose session:`, error);
    }

    // Remove this session from all subscriber subscriptions
    for (const subscriber of this.subscribers) {
      subscriber.subscribedSessions.delete(sessionId);
    }
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionInfo(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const createdAt = this.sessionCreatedAt.get(sessionId) ?? new Date();

    return {
      sessionId,
      sessionName: session.sessionName,
      sessionFile: session.sessionFile,
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      messageCount: session.messages.length,
      createdAt: createdAt.toISOString(),
    };
  }

  listSessions(): SessionInfo[] {
    const infos: SessionInfo[] = [];
    for (const sessionId of this.sessions.keys()) {
      const info = this.getSessionInfo(sessionId);
      if (info) infos.push(info);
    }
    return infos;
  }

  // ==========================================================================
  // SUBSCRIBER MANAGEMENT
  // ==========================================================================

  addSubscriber(subscriber: Subscriber): void {
    this.subscribers.add(subscriber);
  }

  removeSubscriber(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
  }

  subscribeToSession(subscriber: Subscriber, sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} not found`);
    }
    subscriber.subscribedSessions.add(sessionId);
  }

  unsubscribeFromSession(subscriber: Subscriber, sessionId: string): void {
    subscriber.subscribedSessions.delete(sessionId);
  }

  // ==========================================================================
  // EVENT BROADCAST
  // ==========================================================================

  private broadcastEvent(sessionId: string, event: AgentSessionEvent): void {
    // Note: extension_ui_request events are NOT AgentSessionEvents.
    // They come through ExtensionUIContext (wired via bindExtensions)
    // and are broadcast via createServerUIContext -> ExtensionUIManager.broadcastUIRequest.

    const rpcEvent: RpcEvent = {
      type: "event",
      sessionId,
      event,
    };

    let data: string;
    try {
      data = JSON.stringify(rpcEvent);
    } catch (error) {
      // Log serialization errors but don't crash
      console.error(`[broadcastEvent] JSON serialization failed:`, error);
      return;
    }

    // Snapshot subscribers to prevent mutation during iteration
    const snapshot = [...this.subscribers];
    for (const subscriber of snapshot) {
      if (subscriber.subscribedSessions.has(sessionId)) {
        try {
          subscriber.send(data);
        } catch (error) {
          // Log failed sends for observability
          console.error(`[broadcastEvent] Failed to send to subscriber:`, error);
          // Subscriber will be cleaned up by close handler
        }
      }
    }
  }

  broadcast(data: string): void {
    // Snapshot subscribers to prevent mutation during iteration
    const snapshot = [...this.subscribers];
    for (const subscriber of snapshot) {
      try {
        subscriber.send(data);
      } catch (error) {
        // Log failed sends for observability
        console.error(`[broadcast] Failed to send to subscriber:`, error);
      }
    }
  }

  // ==========================================================================
  // COMMAND EXECUTION
  // ==========================================================================

  async executeCommand(command: RpcCommand): Promise<RpcResponse> {
    const id = getCommandId(command);
    const commandType = getCommandType(command);

    // Check for shutdown - reject new commands during shutdown
    if (this.isShuttingDown) {
      return {
        id,
        type: "response",
        command: commandType ?? "unknown",
        success: false,
        error: "Server is shutting down",
      };
    }

    // Input validation FIRST (don't rate-limit invalid commands)
    const validationErrors = validateCommand(command);
    if (validationErrors.length > 0) {
      return {
        id,
        type: "response",
        command: commandType ?? "unknown",
        success: false,
        error: `Validation failed: ${formatValidationErrors(validationErrors)}`,
      };
    }

    // Track this command as in-flight
    return this.trackCommand(this.executeCommandInternal(command, id, commandType));
  }

  /**
   * Internal command execution (called after tracking).
   */
  private async executeCommandInternal(
    command: RpcCommand,
    id: string | undefined,
    commandType: string
  ): Promise<RpcResponse> {
    try {
      // Determine timeout for this command type
      const timeoutMs = SHORT_TIMEOUT_COMMANDS.has(commandType)
        ? SHORT_COMMAND_TIMEOUT_MS
        : DEFAULT_COMMAND_TIMEOUT_MS;

      // Rate limiting AFTER validation - use sessionId for session commands, "_server_" for server commands
      const rateLimitKey = getSessionId(command) ?? "_server_";
      const rateLimitResult = this.governor.canExecuteCommand(rateLimitKey);
      if (!rateLimitResult.allowed) {
        return {
          id,
          type: "response",
          command: commandType,
          success: false,
          error: rateLimitResult.reason,
        };
      }

      // Record heartbeat for session activity
      const cmdSessionId = getSessionId(command);
      if (cmdSessionId) {
        this.governor.recordHeartbeat(cmdSessionId);
      }

      // Server commands (lifecycle management)
      switch (commandType) {
        case "list_sessions":
          return {
            id,
            type: "response",
            command: "list_sessions",
            success: true,
            data: { sessions: this.listSessions() },
          };

        case "create_session": {
          const cmd = command as { sessionId?: string; cwd?: string };
          const newSessionId = cmd.sessionId ?? this.generateSessionId();
          const sessionInfo = await withTimeout(
            this.createSession(newSessionId, cmd.cwd),
            timeoutMs,
            "create_session"
          );
          return {
            id,
            type: "response",
            command: "create_session",
            success: true,
            data: { sessionId: newSessionId, sessionInfo },
          };
        }

        case "delete_session": {
          const cmd = command as { sessionId: string };
          await this.deleteSession(cmd.sessionId);
          return {
            id,
            type: "response",
            command: "delete_session",
            success: true,
            data: { deleted: true },
          };
        }

        case "switch_session": {
          const cmd = command as { sessionId: string };
          const sessionInfo = this.getSessionInfo(cmd.sessionId);
          if (!sessionInfo) {
            return {
              id,
              type: "response",
              command: "switch_session",
              success: false,
              error: `Session ${cmd.sessionId} not found`,
            };
          }
          return {
            id,
            type: "response",
            command: "switch_session",
            success: true,
            data: { sessionInfo },
          };
        }

        case "get_metrics":
          return {
            id,
            type: "response",
            command: "get_metrics",
            success: true,
            data: this.governor.getMetrics(),
          };

        case "health_check": {
          const health = this.governor.isHealthy();
          return {
            id,
            type: "response",
            command: "health_check",
            success: true,
            data: health,
          };
        }
      }

      // Session commands - get the session first
      // cmdSessionId is already defined above for heartbeat recording
      const session = this.sessions.get(cmdSessionId!);
      if (!session) {
        return {
          id,
          type: "response",
          command: commandType,
          success: false,
          error: `Session ${cmdSessionId} not found`,
        };
      }

      // Special handling for extension_ui_response (doesn't operate on session directly)
      if (commandType === "extension_ui_response") {
        const cmd = command as { sessionId: string; requestId: string; response: any };
        const result = this.extensionUI.handleUIResponse({
          id,
          sessionId: cmd.sessionId,
          type: "extension_ui_response",
          requestId: cmd.requestId,
          response: cmd.response,
        });
        if (result.success) {
          return {
            id,
            type: "response",
            command: "extension_ui_response",
            success: true,
          };
        } else {
          return {
            id,
            type: "response",
            command: "extension_ui_response",
            success: false,
            error: result.error ?? "Unknown error",
          };
        }
      }

      // Route to command handler
      const result = routeSessionCommand(session, command, (sid) => this.getSessionInfo(sid));
      if (result === undefined) {
        return {
          id,
          type: "response",
          command: commandType,
          success: false,
          error: `Unknown command type: ${commandType}`,
        };
      }

      // Wrap async handlers with timeout
      if (result instanceof Promise) {
        return withTimeout(result, timeoutMs, commandType);
      }
      return result;
    } catch (error) {
      return {
        id,
        type: "response",
        command: commandType,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  private generateSessionId(): string {
    // Use crypto for collision-safe ID generation
    const timestamp = Date.now().toString(36);
    const random = crypto.randomUUID().split("-")[0];
    return `session-${timestamp}-${random}`;
  }
}
