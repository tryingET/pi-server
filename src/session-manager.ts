/**
 * Session Manager - owns session lifecycle, command execution, and subscriber maps.
 *
 * Server commands handled here. Session commands delegated to command-router.
 * Extension UI requests tracked by ExtensionUIManager.
 */

import { AgentSession, createAgentSession, type AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type {
  SessionInfo,
  RpcCommand,
  RpcResponse,
  RpcEvent,
  Subscriber,
} from "./types.js";
import { routeSessionCommand } from "./command-router.js";
import { ExtensionUIManager } from "./extension-ui.js";
import { createServerUIContext } from "./server-ui-context.js";

export class PiSessionManager {
  private sessions = new Map<string, AgentSession>();
  private sessionCreatedAt = new Map<string, Date>();
  private subscribers = new Set<Subscriber>();
  private unsubscribers = new Map<string, () => void>();

  // Extension UI request tracking
  private extensionUI = new ExtensionUIManager(
    (sessionId: string, event: AgentSessionEvent) => this.broadcastEvent(sessionId, event)
  );

  // ==========================================================================
  // SESSION LIFECYCLE
  // ==========================================================================

  async createSession(sessionId: string, cwd?: string): Promise<SessionInfo> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

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

    // Subscribe to all events from this session
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.broadcastEvent(sessionId, event);
    });
    this.unsubscribers.set(sessionId, unsubscribe);

    return this.getSessionInfo(sessionId)!;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Cancel any pending extension UI requests for this session
    this.extensionUI.cancelSessionRequests(sessionId);

    // Unsubscribe from events
    const unsubscribe = this.unsubscribers.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.unsubscribers.delete(sessionId);
    }

    // Dispose the session
    session.dispose();

    this.sessions.delete(sessionId);
    this.sessionCreatedAt.delete(sessionId);

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

    const data = JSON.stringify(rpcEvent);

    for (const subscriber of this.subscribers) {
      if (subscriber.subscribedSessions.has(sessionId)) {
        try {
          subscriber.send(data);
        } catch {
          // Subscriber may have disconnected, will be cleaned up later
        }
      }
    }
  }

  broadcast(data: string): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber.send(data);
      } catch {
        // Subscriber may have disconnected
      }
    }
  }

  // ==========================================================================
  // COMMAND EXECUTION
  // ==========================================================================

  async executeCommand(command: RpcCommand): Promise<RpcResponse> {
    const id = command.id;

    try {
      // Server commands (lifecycle management)
      switch (command.type) {
        case "list_sessions":
          return {
            id,
            type: "response",
            command: "list_sessions",
            success: true,
            data: { sessions: this.listSessions() },
          };

        case "create_session": {
          const sessionId = command.sessionId ?? this.generateSessionId();
          const sessionInfo = await this.createSession(sessionId, command.cwd);
          return {
            id,
            type: "response",
            command: "create_session",
            success: true,
            data: { sessionId, sessionInfo },
          };
        }

        case "delete_session": {
          await this.deleteSession(command.sessionId);
          return {
            id,
            type: "response",
            command: "delete_session",
            success: true,
            data: { deleted: true },
          };
        }

        case "switch_session": {
          const sessionInfo = this.getSessionInfo(command.sessionId);
          if (!sessionInfo) {
            return {
              id,
              type: "response",
              command: "switch_session",
              success: false,
              error: `Session ${command.sessionId} not found`,
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
      }

      // Session commands - get the session first
      const sessionId = (command as any).sessionId;
      const session = this.sessions.get(sessionId);
      if (!session) {
        return {
          id,
          type: "response",
          command: command.type,
          success: false,
          error: `Session ${sessionId} not found`,
        };
      }

      // Special handling for extension_ui_response (doesn't operate on session directly)
      if (command.type === "extension_ui_response") {
        const result = this.extensionUI.handleUIResponse({
          id,
          sessionId: command.sessionId,
          type: "extension_ui_response",
          requestId: command.requestId,
          response: command.response,
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
          command: command.type,
          success: false,
          error: `Unknown command type: ${command.type}`,
        };
      }
      return result;
    } catch (error) {
      return {
        id,
        type: "response",
        command: command.type,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}
