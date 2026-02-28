/**
 * Server Command Handlers - extensible server command dispatch via handler map.
 *
 * Mirrors the command-router.ts pattern for consistency.
 * Each handler is a self-contained function that executes against
 * the session manager context and returns a response.
 *
 * This extraction from session-manager.ts enables:
 * - O(1) dispatch (handler map vs switch)
 * - Isolated testing of server commands
 * - Easy addition of new server commands
 * - Smaller session-manager.ts (orchestration only)
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { RpcResponse, SessionInfo, StoredSessionInfo } from "./types.js";

// =============================================================================
// HANDLER TYPE
// =============================================================================

/**
 * Context provided to server command handlers.
 * Contains everything handlers need without direct SessionManager coupling.
 */
export interface ServerCommandContext {
  /** Resolve sessions by ID */
  getSession: (sessionId: string) => AgentSession | undefined;
  /** Get session info (includes metadata) */
  getSessionInfo: (sessionId: string) => SessionInfo | undefined;
  /** List all active sessions */
  listSessions: () => SessionInfo[];
  /** Create a new session */
  createSession: (sessionId: string, cwd?: string) => Promise<SessionInfo>;
  /** Delete a session */
  deleteSession: (sessionId: string) => Promise<void>;
  /** Load a session from a stored file */
  loadSession: (sessionId: string, sessionPath: string) => Promise<SessionInfo>;
  /** List stored sessions that can be loaded */
  listStoredSessions: () => Promise<StoredSessionInfo[]>;
  /** Get metrics from governor and stores */
  getMetrics: () => RpcResponse;
  /** Get memory sink metrics (optional, for ADR-0016 metrics system) */
  getMemoryMetrics?: () => Record<string, unknown> | undefined;
  /** Health check */
  getHealth: () => RpcResponse;
  /** Handle extension UI response */
  handleUIResponse: (command: {
    id?: string;
    sessionId: string;
    type: "extension_ui_response";
    requestId: string;
    response: any;
  }) => { success: boolean; error?: string };
  /** Route session command to appropriate handler */
  routeSessionCommand: (
    session: AgentSession,
    command: any,
    getSessionInfo: (sessionId: string) => SessionInfo | undefined
  ) => Promise<RpcResponse> | RpcResponse | undefined;
  /** Generate a unique session ID */
  generateSessionId: () => string;
  /** Record heartbeat for session activity */
  recordHeartbeat: (sessionId: string) => void;
  /** Get circuit breaker manager */
  getCircuitBreakers: () => {
    hasOpenCircuit: () => boolean;
    getBreaker: (provider: string) => {
      canExecute: () => { allowed: boolean; reason?: string };
      recordSuccess: (elapsedMs: number) => void;
      recordFailure: (type: "timeout" | "error") => void;
    };
  };
  /** Get default command timeout in ms */
  getDefaultCommandTimeoutMs: () => number;
}

export type ServerCommandHandler = (
  command: any,
  context: ServerCommandContext
) => Promise<RpcResponse> | RpcResponse;

// =============================================================================
// SESSION LIFECYCLE HANDLERS
// =============================================================================

const handleListSessions: ServerCommandHandler = async (_command, context) => {
  return {
    type: "response" as const,
    command: "list_sessions" as const,
    success: true,
    data: { sessions: context.listSessions() },
  };
};

const handleCreateSession: ServerCommandHandler = async (command, context) => {
  const sessionId = command.sessionId ?? context.generateSessionId();
  const sessionInfo = await context.createSession(sessionId, command.cwd);
  return {
    type: "response" as const,
    command: "create_session" as const,
    success: true,
    data: { sessionId, sessionInfo },
  };
};

const handleDeleteSession: ServerCommandHandler = async (command, context) => {
  await context.deleteSession(command.sessionId);
  return {
    type: "response" as const,
    command: "delete_session" as const,
    success: true,
    data: { deleted: true },
  };
};

const handleSwitchSession: ServerCommandHandler = (command, context) => {
  const sessionInfo = context.getSessionInfo(command.sessionId);
  if (!sessionInfo) {
    return {
      type: "response" as const,
      command: "switch_session" as const,
      success: false,
      error: `Session ${command.sessionId} not found`,
    };
  }
  return {
    type: "response" as const,
    command: "switch_session" as const,
    success: true,
    data: { sessionInfo },
  };
};

// =============================================================================
// PERSISTENCE HANDLERS (ADR-0007)
// =============================================================================

const handleListStoredSessions: ServerCommandHandler = async (_command, context) => {
  const storedSessions = await context.listStoredSessions();
  return {
    type: "response" as const,
    command: "list_stored_sessions" as const,
    success: true,
    data: { sessions: storedSessions },
  };
};

const handleLoadSession: ServerCommandHandler = async (command, context) => {
  const sessionId = command.sessionId ?? context.generateSessionId();
  try {
    const sessionInfo = await context.loadSession(sessionId, command.sessionPath);
    return {
      type: "response" as const,
      command: "load_session" as const,
      success: true,
      data: { sessionId, sessionInfo },
    };
  } catch (error) {
    return {
      type: "response" as const,
      command: "load_session" as const,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

// =============================================================================
// METRICS & HEALTH HANDLERS
// =============================================================================

const handleGetMetrics: ServerCommandHandler = (_command, context) => {
  const response = context.getMetrics();
  // Add memory sink metrics if available (ADR-0016)
  if (context.getMemoryMetrics && response.success) {
    const memoryMetrics = context.getMemoryMetrics();
    if (memoryMetrics && 'data' in response && response.data) {
      (response.data as Record<string, unknown>).metrics = memoryMetrics;
    }
  }
  return response;
};

const handleHealthCheck: ServerCommandHandler = (_command, context) => {
  return context.getHealth();
};

// =============================================================================
// EXTENSION UI HANDLER
// =============================================================================

const handleExtensionUIResponse: ServerCommandHandler = (command, context) => {
  const result = context.handleUIResponse({
    id: command.id,
    sessionId: command.sessionId,
    type: "extension_ui_response",
    requestId: command.requestId,
    response: command.response,
  });

  if (result.success) {
    return {
      id: command.id,
      type: "response" as const,
      command: "extension_ui_response" as const,
      success: true,
    };
  }
  return {
    id: command.id,
    type: "response" as const,
    command: "extension_ui_response" as const,
    success: false,
    error: result.error ?? "Unknown error",
  };
};

// =============================================================================
// LLM COMMAND EXECUTION HELPER
// =============================================================================

/** LLM commands that should be protected by circuit breaker */
const LLM_COMMANDS = new Set(["prompt", "steer", "follow_up", "compact"]);

/**
 * Execute an LLM command with circuit breaker protection.
 * Returns undefined if not an LLM command (caller should route normally).
 */
export async function executeLLMCommand(
  command: any,
  session: AgentSession,
  context: ServerCommandContext
): Promise<RpcResponse | undefined> {
  const commandType = command.type;
  const provider = session.model?.provider;

  // Not an LLM command - let normal routing handle it
  if (!LLM_COMMANDS.has(commandType) || !provider) {
    return undefined;
  }

  const breaker = context.getCircuitBreakers().getBreaker(provider);
  const breakerCheck = breaker.canExecute();

  if (!breakerCheck.allowed) {
    return {
      id: command.id,
      type: "response" as const,
      command: commandType,
      success: false,
      error: breakerCheck.reason ?? "Circuit breaker open",
    };
  }

  const startTime = Date.now();
  try {
    const routed = context.routeSessionCommand(session, command, context.getSessionInfo);
    if (routed === undefined) {
      return undefined;
    }

    const response = await Promise.resolve(routed);
    const elapsedMs = Date.now() - startTime;

    if (response.success) {
      breaker.recordSuccess(elapsedMs);
    } else {
      const errorMsg = response.error?.toLowerCase() ?? "";
      if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
        breaker.recordFailure("timeout");
      } else {
        breaker.recordFailure("error");
      }
    }

    return response;
  } catch (error) {
    const elapsedMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message.toLowerCase() : "";
    if (errorMsg.includes("timeout") || elapsedMs >= context.getDefaultCommandTimeoutMs()) {
      breaker.recordFailure("timeout");
    } else {
      breaker.recordFailure("error");
    }
    throw error;
  }
}

// =============================================================================
// HANDLER MAP
// =============================================================================

export const serverCommandHandlers: Record<string, ServerCommandHandler> = {
  // Session lifecycle
  list_sessions: handleListSessions,
  create_session: handleCreateSession,
  delete_session: handleDeleteSession,
  switch_session: handleSwitchSession,
  // Persistence (ADR-0007)
  list_stored_sessions: handleListStoredSessions,
  load_session: handleLoadSession,
  // Metrics & health
  get_metrics: handleGetMetrics,
  health_check: handleHealthCheck,
  // Extension UI
  extension_ui_response: handleExtensionUIResponse,
};

// =============================================================================
// ROUTING FUNCTION
// =============================================================================

/**
 * Route a server command to the appropriate handler.
 * Returns a response or undefined if no handler exists (unknown command).
 */
export function routeServerCommand(
  command: any,
  context: ServerCommandContext
): Promise<RpcResponse> | RpcResponse | undefined {
  const handler = serverCommandHandlers[command.type];
  if (!handler) {
    return undefined;
  }
  return handler(command, context);
}

/**
 * Get list of supported server command types.
 */
export function getSupportedServerCommands(): string[] {
  return Object.keys(serverCommandHandlers);
}
