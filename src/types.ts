/**
 * Protocol types for pi-app-server session multiplexer.
 * The protocol IS the architecture.
 */

import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ImageContent, Model } from "@mariozechner/pi-ai";
import type { SessionStats } from "@mariozechner/pi-coding-agent";
import type { CompactionResult } from "@mariozechner/pi-coding-agent";
import type { CircuitBreakerMetrics } from "./circuit-breaker.js";

// ============================================================================
// SESSION INFO
// ============================================================================

export interface SessionInfo {
  sessionId: string;
  sessionName?: string;
  sessionFile?: string;
  model?: Model<any>;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  messageCount: number;
  createdAt: string;
}

// ============================================================================
// SERVER COMMANDS (manage session registry)
// ============================================================================

export type ServerCommand =
  | { id?: string; type: "list_sessions" }
  | { id?: string; type: "create_session"; sessionId?: string; cwd?: string }
  | { id?: string; type: "delete_session"; sessionId: string }
  | { id?: string; type: "switch_session"; sessionId: string }
  | { id?: string; type: "get_metrics" }
  | { id?: string; type: "health_check" }
  // ADR-0007: Session persistence
  | { id?: string; type: "list_stored_sessions" }
  | { id?: string; type: "load_session"; sessionId?: string; sessionPath: string };

// ============================================================================
// SESSION COMMANDS (pass through to AgentSession)
// ============================================================================

export type SessionCommand =
  // Extension UI response (client → server to complete pending UI request)
  | {
      id?: string;
      sessionId: string;
      type: "extension_ui_response";
      requestId: string;
      response:
        | { method: "select"; value: string }
        | { method: "confirm"; confirmed: boolean }
        | { method: "input"; value: string }
        | { method: "editor"; value: string }
        | { method: "interview"; responses: Record<string, any> }
        | { method: "cancelled" };
    }
  // Discovery commands
  | { id?: string; sessionId: string; type: "get_available_models" }
  | { id?: string; sessionId: string; type: "get_commands" }
  | { id?: string; sessionId: string; type: "get_skills" }
  | { id?: string; sessionId: string; type: "get_tools" }
  | { id?: string; sessionId: string; type: "list_session_files" }
  // Session commands
  | {
      id?: string;
      sessionId: string;
      type: "prompt";
      message: string;
      images?: ImageContent[];
      streamingBehavior?: "steer" | "followUp";
    }
  | { id?: string; sessionId: string; type: "steer"; message: string; images?: ImageContent[] }
  | { id?: string; sessionId: string; type: "follow_up"; message: string; images?: ImageContent[] }
  | { id?: string; sessionId: string; type: "abort" }
  | { id?: string; sessionId: string; type: "get_state" }
  | { id?: string; sessionId: string; type: "get_messages" }
  | { id?: string; sessionId: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; sessionId: string; type: "cycle_model"; direction?: "forward" | "backward" }
  | { id?: string; sessionId: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; sessionId: string; type: "cycle_thinking_level" }
  | { id?: string; sessionId: string; type: "compact"; customInstructions?: string }
  | { id?: string; sessionId: string; type: "abort_compaction" }
  | { id?: string; sessionId: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; sessionId: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; sessionId: string; type: "abort_retry" }
  | { id?: string; sessionId: string; type: "bash"; command: string; excludeFromContext?: boolean }
  | { id?: string; sessionId: string; type: "abort_bash" }
  | { id?: string; sessionId: string; type: "get_session_stats" }
  | { id?: string; sessionId: string; type: "set_session_name"; name: string }
  | { id?: string; sessionId: string; type: "export_html"; outputPath?: string }
  | { id?: string; sessionId: string; type: "new_session"; parentSession?: string }
  | { id?: string; sessionId: string; type: "switch_session_file"; sessionPath: string }
  | { id?: string; sessionId: string; type: "fork"; entryId: string }
  | { id?: string; sessionId: string; type: "get_fork_messages" }
  | { id?: string; sessionId: string; type: "get_last_assistant_text" }
  | { id?: string; sessionId: string; type: "get_context_usage" };

// ============================================================================
// UNION OF ALL COMMANDS
// ============================================================================

export interface RpcCommandEnvelope {
  /** Optional causal dependencies for command ordering. */
  dependsOn?: string[];
  /** Optional optimistic concurrency precondition for session-targeted commands. */
  ifSessionVersion?: number;
  /** Optional idempotency key for replay-safe retries. */
  idempotencyKey?: string;
}

export type RpcCommand = (ServerCommand | SessionCommand) & RpcCommandEnvelope;

// ============================================================================
// RESPONSES
// ============================================================================

export interface RpcResponseBase {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  /** Monotonic per-session version after successful command execution. */
  sessionVersion?: number;
  /** True when response was replayed from idempotency/duplicate-command cache. */
  replayed?: boolean;
  /** True when the response is due to a timeout (ADR-0001: timeout IS a response). */
  timedOut?: boolean;
}

// Server command responses
export type ServerResponse =
  | (RpcResponseBase & {
      command: "list_sessions";
      success: true;
      data: { sessions: SessionInfo[] };
    })
  | (RpcResponseBase & {
      command: "create_session";
      success: true;
      data: { sessionId: string; sessionInfo: SessionInfo };
    })
  | (RpcResponseBase & { command: "delete_session"; success: true; data: { deleted: true } })
  | (RpcResponseBase & {
      command: "switch_session";
      success: true;
      data: { sessionInfo: SessionInfo };
    })
  | (RpcResponseBase & {
      command: "get_metrics";
      success: true;
      data: {
        sessionCount: number;
        connectionCount: number;
        totalCommandsExecuted: number;
        commandsRejected: {
          sessionLimit: number;
          messageSize: number;
          rateLimit: number;
          globalRateLimit: number;
          connectionLimit: number;
          extensionUIResponseRateLimit: number;
        };
        zombieSessionsDetected: number;
        zombieSessionsCleaned: number;
        doubleUnregisterErrors: number;
        rateLimitUsage: {
          globalCount: number;
          globalLimit: number;
        };
        /** Store stats for observability (ADR-0001) */
        stores: {
          replay: {
            inFlightCount: number;
            outcomeCount: number;
            idempotencyCacheSize: number;
            maxInFlightCommands: number;
            maxCommandOutcomes: number;
            inFlightRejections: number;
          };
          version: {
            sessionCount: number;
          };
          execution: {
            laneCount: number;
          };
          lock: {
            activeLocks: number;
            timeoutCount: number;
            waitingCount: number;
          };
          extensionUI: {
            pendingCount: number;
            maxPendingRequests: number;
            rejectedCount: number;
          };
          sessionStore: {
            /** Count of metadata file resets due to corruption/oversize */
            metadataResetCount: number;
          };
        };
        /** Circuit breaker metrics per provider (ADR-0010) */
        circuitBreakers: CircuitBreakerMetrics[];
        /** Bash circuit breaker metrics */
        bashCircuitBreaker: {
          enabled: boolean;
          globalState: string;
          sessionCount: number;
          openSessionCount: number;
          totalCalls: number;
          totalTimeouts: number;
          totalRejected: number;
        };
        /** Metrics system data (ADR-0016) - optional, only if MemorySink is enabled */
        metrics?: Record<string, unknown>;
      };
    })
  | (RpcResponseBase & {
      command: "health_check";
      success: true;
      data: {
        healthy: boolean;
        issues: string[];
        /** Whether any LLM provider circuit is open (ADR-0010) */
        hasOpenCircuit: boolean;
        /** Whether bash command circuit is open */
        hasOpenBashCircuit: boolean;
      };
    })
  // ADR-0007: Session persistence
  | (RpcResponseBase & {
      command: "list_stored_sessions";
      success: true;
      data: { sessions: StoredSessionInfo[] };
    })
  | (RpcResponseBase & {
      command: "load_session";
      success: true;
      data: { sessionId: string; sessionInfo: SessionInfo };
    });

// ADR-0007: Stored session info (extends SessionInfo with persistence metadata)
export interface StoredSessionInfo extends SessionInfo {
  /** Path to the session file (use this for load_session command) */
  sessionFile: string;
  /** Alias for sessionFile (for consistency with load_session's sessionPath parameter) */
  sessionPath: string;
  cwd: string;
  fileExists: boolean;
}

// Session command responses (mirrors RpcCommand types)
export type SessionResponse =
  | (RpcResponseBase & { command: "extension_ui_response"; success: true })
  // Discovery command responses
  | (RpcResponseBase & {
      command: "get_available_models";
      success: true;
      data: { models: Model<any>[] };
    })
  | (RpcResponseBase & {
      command: "get_commands";
      success: true;
      data: {
        commands: Array<{
          name: string;
          description?: string;
          source: string;
          location?: string;
          path?: string;
        }>;
      };
    })
  | (RpcResponseBase & {
      command: "get_skills";
      success: true;
      data: {
        skills: Array<{ name: string; description: string; filePath: string; source: string }>;
      };
    })
  | (RpcResponseBase & {
      command: "get_tools";
      success: true;
      data: { tools: Array<{ name: string; description: string }> };
    })
  | (RpcResponseBase & {
      command: "list_session_files";
      success: true;
      data: { files: Array<{ path: string; name: string; modifiedAt?: string }> };
    })
  // Session commands
  | (RpcResponseBase & { command: "prompt"; success: true })
  | (RpcResponseBase & { command: "steer"; success: true })
  | (RpcResponseBase & { command: "follow_up"; success: true })
  | (RpcResponseBase & { command: "abort"; success: true })
  | (RpcResponseBase & { command: "get_state"; success: true; data: SessionInfo })
  | (RpcResponseBase & {
      command: "get_messages";
      success: true;
      data: { messages: AgentMessage[] };
    })
  | (RpcResponseBase & { command: "set_model"; success: true; data: { model: Model<any> } })
  | (RpcResponseBase & {
      command: "cycle_model";
      success: true;
      data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
    })
  | (RpcResponseBase & { command: "set_thinking_level"; success: true })
  | (RpcResponseBase & {
      command: "cycle_thinking_level";
      success: true;
      data: { level: ThinkingLevel } | null;
    })
  | (RpcResponseBase & { command: "compact"; success: true; data: CompactionResult })
  | (RpcResponseBase & { command: "abort_compaction"; success: true })
  | (RpcResponseBase & { command: "set_auto_compaction"; success: true })
  | (RpcResponseBase & { command: "set_auto_retry"; success: true })
  | (RpcResponseBase & { command: "abort_retry"; success: true })
  | (RpcResponseBase & {
      command: "bash";
      success: true;
      data: { exitCode: number; output: string; cancelled: boolean };
    })
  | (RpcResponseBase & { command: "abort_bash"; success: true })
  | (RpcResponseBase & { command: "get_session_stats"; success: true; data: SessionStats })
  | (RpcResponseBase & { command: "set_session_name"; success: true })
  | (RpcResponseBase & { command: "export_html"; success: true; data: { path: string } })
  | (RpcResponseBase & { command: "new_session"; success: true; data: { cancelled: boolean } })
  | (RpcResponseBase & {
      command: "switch_session_file";
      success: true;
      data: { cancelled: boolean };
    })
  | (RpcResponseBase & {
      command: "fork";
      success: true;
      data: { text: string; cancelled: boolean };
    })
  | (RpcResponseBase & {
      command: "get_fork_messages";
      success: true;
      data: { messages: Array<{ entryId: string; text: string }> };
    })
  | (RpcResponseBase & {
      command: "get_last_assistant_text";
      success: true;
      data: { text: string | null };
    })
  | (RpcResponseBase & {
      command: "get_context_usage";
      success: true;
      data: { tokens: number | null; contextWindow: number; percent: number | null } | null;
    });

// Error response
export type ErrorResponse = RpcResponseBase & { success: false; error: string };

export type RpcResponse = ServerResponse | SessionResponse | ErrorResponse;

// ============================================================================
// EVENTS
// ============================================================================

export interface RpcEvent {
  type: "event";
  sessionId: string;
  event: AgentSessionEvent;
}

export interface ServerEvent {
  type: "server_ready";
  data: {
    /** Server software version (semver) */
    serverVersion: string;
    /** Protocol version for wire compatibility (semver) */
    protocolVersion: string;
    /** Available transports */
    transports: string[];
  };
}

export interface ServerShutdownEvent {
  type: "server_shutdown";
  data: { reason: string; timeoutMs?: number };
}

export interface SessionLifecycleEvent {
  type: "session_created" | "session_deleted";
  data: { sessionId: string; sessionInfo?: SessionInfo };
}

export interface CommandLifecycleEvent {
  type: "command_accepted" | "command_started" | "command_finished";
  data: {
    commandId: string;
    commandType: string;
    sessionId?: string;
    dependsOn?: string[];
    ifSessionVersion?: number;
    idempotencyKey?: string;
    success?: boolean;
    error?: string;
    sessionVersion?: number;
    replayed?: boolean;
  };
}

export type RpcBroadcast =
  | RpcEvent
  | ServerEvent
  | ServerShutdownEvent
  | SessionLifecycleEvent
  | CommandLifecycleEvent;

// ============================================================================
// SUBSCRIBER
// ============================================================================

export interface Subscriber {
  send: (data: string) => void;
  subscribedSessions: Set<string>;
}

// ============================================================================
// SESSION RESOLVER
// ============================================================================

import type { AgentSession } from "@mariozechner/pi-coding-agent";

/**
 * Interface for resolving sessions by ID.
 *
 * This is the NEXUS abstraction - a clean seam that enables:
 * - Test doubles for unit testing without real AgentSession
 * - Future multi-server clustering (resolver over RPC)
 * - Session migration between servers
 * - Dependency injection for cleaner architecture
 *
 * Implementations must be idempotent: calling getSession multiple times
 * with the same ID returns the same session (or undefined consistently).
 */
export interface SessionResolver {
  /**
   * Get a session by ID.
   * @returns The session if it exists, undefined otherwise.
   */
  getSession(sessionId: string): AgentSession | undefined;
}

// ============================================================================
// TYPE GUARDS & ACCESSORS
// Moved to type-guards.ts for separation of concerns
// ============================================================================

// Re-export from type-guards.ts for backwards compatibility
export {
  getCommandId,
  getCommandType,
  getSessionId,
  getCommandDependsOn,
  getCommandIfSessionVersion,
  getCommandIdempotencyKey,
  isSessionCommand,
  isCreateSessionResponse,
  isSwitchSessionResponse,
} from "./type-guards.js";
