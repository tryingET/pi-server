/**
 * Session Manager - owns session lifecycle, command execution, and subscriber maps.
 *
 * One switch statement for command execution. That's it.
 */

import { AgentSession, createAgentSession, type AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type {
  SessionInfo,
  RpcCommand,
  RpcResponse,
  RpcEvent,
  Subscriber,
} from "./types.js";

export class PiSessionManager {
  private sessions = new Map<string, AgentSession>();
  private sessionCreatedAt = new Map<string, Date>();
  private subscribers = new Set<Subscriber>();
  private unsubscribers = new Map<string, () => void>();

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
  // COMMAND EXECUTION (THE ONE AND ONLY SWITCH)
  // ==========================================================================

  async executeCommand(command: RpcCommand): Promise<RpcResponse> {
    const id = command.id;

    try {
      // Server commands
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

      // Session commands - get the session
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

      // Session command dispatch
      switch (command.type) {
        case "prompt":
          await session.prompt(command.message, {
            images: command.images,
            streamingBehavior: command.streamingBehavior,
          });
          return { id, type: "response", command: "prompt", success: true };

        case "steer":
          await session.steer(command.message, command.images);
          return { id, type: "response", command: "steer", success: true };

        case "follow_up":
          await session.followUp(command.message, command.images);
          return { id, type: "response", command: "follow_up", success: true };

        case "abort":
          await session.abort();
          return { id, type: "response", command: "abort", success: true };

        case "get_state": {
          const info = this.getSessionInfo(sessionId)!;
          return { id, type: "response", command: "get_state", success: true, data: info };
        }

        case "get_messages":
          return {
            id,
            type: "response",
            command: "get_messages",
            success: true,
            data: { messages: session.messages },
          };

        case "set_model":
          await session.setModel((session.modelRegistry as any).getModel(command.provider, command.modelId));
          return {
            id,
            type: "response",
            command: "set_model",
            success: true,
            data: { model: session.model! },
          };

        case "cycle_model": {
          const result = await session.cycleModel(command.direction);
          return {
            id,
            type: "response",
            command: "cycle_model",
            success: true,
            data: result ? { model: result.model, thinkingLevel: result.thinkingLevel, isScoped: result.isScoped } : null,
          };
        }

        case "set_thinking_level":
          session.setThinkingLevel(command.level);
          return { id, type: "response", command: "set_thinking_level", success: true };

        case "cycle_thinking_level": {
          const level = session.cycleThinkingLevel();
          return {
            id,
            type: "response",
            command: "cycle_thinking_level",
            success: true,
            data: level ? { level } : null,
          };
        }

        case "compact": {
          const result = await session.compact(command.customInstructions);
          return { id, type: "response", command: "compact", success: true, data: result };
        }

        case "abort_compaction":
          session.abortCompaction();
          return { id, type: "response", command: "abort_compaction", success: true };

        case "set_auto_compaction":
          session.setAutoCompactionEnabled(command.enabled);
          return { id, type: "response", command: "set_auto_compaction", success: true };

        case "set_auto_retry":
          session.setAutoRetryEnabled(command.enabled);
          return { id, type: "response", command: "set_auto_retry", success: true };

        case "abort_retry":
          session.abortRetry();
          return { id, type: "response", command: "abort_retry", success: true };

        case "bash": {
          const result = await session.executeBash(command.command, undefined, {
            excludeFromContext: command.excludeFromContext,
          });
          return {
            id,
            type: "response",
            command: "bash",
            success: true,
            data: { exitCode: result.exitCode ?? 0, output: result.output, cancelled: result.cancelled },
          };
        }

        case "abort_bash":
          session.abortBash();
          return { id, type: "response", command: "abort_bash", success: true };

        case "get_session_stats": {
          const stats = session.getSessionStats();
          return { id, type: "response", command: "get_session_stats", success: true, data: stats };
        }

        case "set_session_name":
          session.setSessionName(command.name);
          return { id, type: "response", command: "set_session_name", success: true };

        case "export_html": {
          const path = await session.exportToHtml(command.outputPath);
          return { id, type: "response", command: "export_html", success: true, data: { path } };
        }

        case "new_session": {
          const cancelled = !(await session.newSession({ parentSession: command.parentSession }));
          return { id, type: "response", command: "new_session", success: true, data: { cancelled } };
        }

        case "switch_session_file": {
          const cancelled = !(await session.switchSession(command.sessionPath));
          return { id, type: "response", command: "switch_session_file", success: true, data: { cancelled } };
        }

        case "fork": {
          const result = await session.fork(command.entryId);
          return {
            id,
            type: "response",
            command: "fork",
            success: true,
            data: { text: result.selectedText, cancelled: result.cancelled },
          };
        }

        case "get_fork_messages": {
          const messages = session.getUserMessagesForForking();
          return {
            id,
            type: "response",
            command: "get_fork_messages",
            success: true,
            data: { messages },
          };
        }

        case "get_last_assistant_text": {
          const text = session.getLastAssistantText();
          return {
            id,
            type: "response",
            command: "get_last_assistant_text",
            success: true,
            data: { text: text ?? null },
          };
        }

        case "get_context_usage": {
          const usage = session.getContextUsage();
          return {
            id,
            type: "response",
            command: "get_context_usage",
            success: true,
            data: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : null,
          };
        }

        default:
          return {
            id,
            type: "response",
            command: (command as any).type,
            success: false,
            error: `Unknown command type: ${(command as any).type}`,
          };
      }
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
