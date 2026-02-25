/**
 * Command Router - extensible command dispatch via handler map.
 *
 * Each handler is a self-contained function that takes a session and command,
 * executes against the session, and returns a response.
 *
 * This replaces the giant switch statement, enabling:
 * - Easy addition of new commands
 * - Isolated testing of handlers
 * - Clear separation of concerns
 */

import path from "path";
import { type AgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import type { RpcResponse, SessionInfo } from "./types.js";

// =============================================================================
// HANDLER TYPE
// =============================================================================

export type CommandHandler = (
  session: AgentSession,
  command: any,
  getSessionInfo: (sessionId: string) => SessionInfo | undefined
) => Promise<RpcResponse> | RpcResponse;

// =============================================================================
// HANDLER IMPLEMENTATIONS
// =============================================================================

const handlePrompt: CommandHandler = async (session, command) => {
  await session.prompt(command.message, {
    images: command.images,
    streamingBehavior: command.streamingBehavior,
  });
  return { id: command.id, type: "response", command: "prompt", success: true };
};

const handleSteer: CommandHandler = async (session, command) => {
  await session.steer(command.message, command.images);
  return { id: command.id, type: "response", command: "steer", success: true };
};

const handleFollowUp: CommandHandler = async (session, command) => {
  await session.followUp(command.message, command.images);
  return { id: command.id, type: "response", command: "follow_up", success: true };
};

const handleAbort: CommandHandler = async (session, command) => {
  await session.abort();
  return { id: command.id, type: "response", command: "abort", success: true };
};

const handleGetState: CommandHandler = (_session, command, getSessionInfo) => {
  const info = getSessionInfo(command.sessionId);
  if (!info) {
    return {
      id: command.id,
      type: "response",
      command: "get_state",
      success: false,
      error: `Session ${command.sessionId} not found`,
    };
  }
  return { id: command.id, type: "response", command: "get_state", success: true, data: info };
};

const handleGetMessages: CommandHandler = (session, command) => {
  return {
    id: command.id,
    type: "response",
    command: "get_messages",
    success: true,
    data: { messages: session.messages },
  };
};

const handleSetModel: CommandHandler = async (session, command) => {
  // Use public API: modelRegistry.find() instead of internal getModel()
  const model = session.modelRegistry.find(command.provider, command.modelId);
  if (!model) {
    return {
      id: command.id,
      type: "response",
      command: "set_model",
      success: false,
      error: `Model not found: ${command.provider}/${command.modelId}`,
    };
  }
  await session.setModel(model);
  return {
    id: command.id,
    type: "response",
    command: "set_model",
    success: true,
    data: { model: session.model! },
  };
};

const handleCycleModel: CommandHandler = async (session, command) => {
  const result = await session.cycleModel(command.direction);
  return {
    id: command.id,
    type: "response",
    command: "cycle_model",
    success: true,
    data: result
      ? { model: result.model, thinkingLevel: result.thinkingLevel, isScoped: result.isScoped }
      : null,
  };
};

const handleSetThinkingLevel: CommandHandler = (session, command) => {
  session.setThinkingLevel(command.level);
  return { id: command.id, type: "response", command: "set_thinking_level", success: true };
};

const handleCycleThinkingLevel: CommandHandler = (session, command) => {
  const level = session.cycleThinkingLevel();
  return {
    id: command.id,
    type: "response",
    command: "cycle_thinking_level",
    success: true,
    data: level ? { level } : null,
  };
};

const handleCompact: CommandHandler = async (session, command) => {
  const result = await session.compact(command.customInstructions);
  return { id: command.id, type: "response", command: "compact", success: true, data: result };
};

const handleAbortCompaction: CommandHandler = (session, command) => {
  session.abortCompaction();
  return { id: command.id, type: "response", command: "abort_compaction", success: true };
};

const handleSetAutoCompaction: CommandHandler = (session, command) => {
  session.setAutoCompactionEnabled(command.enabled);
  return { id: command.id, type: "response", command: "set_auto_compaction", success: true };
};

const handleSetAutoRetry: CommandHandler = (session, command) => {
  session.setAutoRetryEnabled(command.enabled);
  return { id: command.id, type: "response", command: "set_auto_retry", success: true };
};

const handleAbortRetry: CommandHandler = (session, command) => {
  session.abortRetry();
  return { id: command.id, type: "response", command: "abort_retry", success: true };
};

const handleBash: CommandHandler = async (session, command) => {
  const result = await session.executeBash(command.command, undefined, {
    excludeFromContext: command.excludeFromContext,
  });
  return {
    id: command.id,
    type: "response",
    command: "bash",
    success: true,
    data: { exitCode: result.exitCode ?? 0, output: result.output, cancelled: result.cancelled },
  };
};

const handleAbortBash: CommandHandler = (session, command) => {
  session.abortBash();
  return { id: command.id, type: "response", command: "abort_bash", success: true };
};

const handleGetSessionStats: CommandHandler = (session, command) => {
  const stats = session.getSessionStats();
  return {
    id: command.id,
    type: "response",
    command: "get_session_stats",
    success: true,
    data: stats,
  };
};

const handleSetSessionName: CommandHandler = (session, command) => {
  session.setSessionName(command.name);
  return { id: command.id, type: "response", command: "set_session_name", success: true };
};

const handleExportHtml: CommandHandler = async (session, command) => {
  const path = await session.exportToHtml(command.outputPath);
  return {
    id: command.id,
    type: "response",
    command: "export_html",
    success: true,
    data: { path },
  };
};

const handleNewSession: CommandHandler = async (session, command) => {
  const cancelled = !(await session.newSession({ parentSession: command.parentSession }));
  return {
    id: command.id,
    type: "response",
    command: "new_session",
    success: true,
    data: { cancelled },
  };
};

const handleSwitchSessionFile: CommandHandler = async (session, command) => {
  const cancelled = !(await session.switchSession(command.sessionPath));
  return {
    id: command.id,
    type: "response",
    command: "switch_session_file",
    success: true,
    data: { cancelled },
  };
};

const handleFork: CommandHandler = async (session, command) => {
  const result = await session.fork(command.entryId);
  return {
    id: command.id,
    type: "response",
    command: "fork",
    success: true,
    data: { text: result.selectedText, cancelled: result.cancelled },
  };
};

const handleGetForkMessages: CommandHandler = (session, command) => {
  const messages = session.getUserMessagesForForking();
  return {
    id: command.id,
    type: "response",
    command: "get_fork_messages",
    success: true,
    data: { messages },
  };
};

const handleGetLastAssistantText: CommandHandler = (session, command) => {
  const text = session.getLastAssistantText();
  return {
    id: command.id,
    type: "response",
    command: "get_last_assistant_text",
    success: true,
    data: { text: text ?? null },
  };
};

const handleGetContextUsage: CommandHandler = (session, command) => {
  const usage = session.getContextUsage();
  return {
    id: command.id,
    type: "response",
    command: "get_context_usage",
    success: true,
    data: usage
      ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
      : null,
  };
};

// =============================================================================
// DISCOVERY HANDLERS
// =============================================================================

const handleGetAvailableModels: CommandHandler = (session, command) => {
  const models = session.modelRegistry.getAvailable();
  return {
    id: command.id,
    type: "response",
    command: "get_available_models",
    success: true,
    data: { models },
  };
};

const handleGetCommands: CommandHandler = (session, command) => {
  // Get commands from resourceLoader's extensions
  const extensions = session.resourceLoader.getExtensions();
  const commands: Array<{
    name: string;
    description?: string;
    source: string;
    location?: string;
    path?: string;
  }> = [];

  for (const ext of extensions.extensions) {
    for (const [name, cmd] of ext.commands) {
      commands.push({
        name,
        description: cmd.description,
        source: "extension",
        path: ext.path,
      });
    }
  }

  // Add skills as commands
  const skillsResult = session.resourceLoader.getSkills();
  for (const skill of skillsResult.skills) {
    commands.push({
      name: skill.name,
      description: skill.description,
      source: "skill",
      path: skill.filePath,
    });
  }

  // Add prompts as commands
  const promptsResult = session.resourceLoader.getPrompts();
  for (const prompt of promptsResult.prompts) {
    commands.push({
      name: prompt.name,
      description: prompt.description,
      source: "prompt",
      path: prompt.filePath,
    });
  }

  return {
    id: command.id,
    type: "response",
    command: "get_commands",
    success: true,
    data: { commands },
  };
};

const handleGetSkills: CommandHandler = (session, command) => {
  const skillsResult = session.resourceLoader.getSkills();
  const skills = skillsResult.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    source: skill.source,
  }));

  return {
    id: command.id,
    type: "response",
    command: "get_skills",
    success: true,
    data: { skills },
  };
};

const handleGetTools: CommandHandler = (session, command) => {
  const tools = session.getAllTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
  }));

  return {
    id: command.id,
    type: "response",
    command: "get_tools",
    success: true,
    data: { tools },
  };
};

const handleListSessionFiles: CommandHandler = async (session, command) => {
  // Get session files from the session manager (static async method)
  const cwd = session.sessionManager.getCwd();
  const files = await SessionManager.list(cwd);

  const formattedFiles = files.map((file) => ({
    path: file.path,
    name: path.basename(file.path), // Cross-platform basename extraction
    modifiedAt: file.modified.toISOString(),
  }));

  return {
    id: command.id,
    type: "response",
    command: "list_session_files",
    success: true,
    data: { files: formattedFiles },
  };
};

// =============================================================================
// HANDLER MAP
// =============================================================================

export const sessionCommandHandlers: Record<string, CommandHandler> = {
  // Discovery commands
  get_available_models: handleGetAvailableModels,
  get_commands: handleGetCommands,
  get_skills: handleGetSkills,
  get_tools: handleGetTools,
  list_session_files: handleListSessionFiles,
  // Session commands
  prompt: handlePrompt,
  steer: handleSteer,
  follow_up: handleFollowUp,
  abort: handleAbort,
  get_state: handleGetState,
  get_messages: handleGetMessages,
  set_model: handleSetModel,
  cycle_model: handleCycleModel,
  set_thinking_level: handleSetThinkingLevel,
  cycle_thinking_level: handleCycleThinkingLevel,
  compact: handleCompact,
  abort_compaction: handleAbortCompaction,
  set_auto_compaction: handleSetAutoCompaction,
  set_auto_retry: handleSetAutoRetry,
  abort_retry: handleAbortRetry,
  bash: handleBash,
  abort_bash: handleAbortBash,
  get_session_stats: handleGetSessionStats,
  set_session_name: handleSetSessionName,
  export_html: handleExportHtml,
  new_session: handleNewSession,
  switch_session_file: handleSwitchSessionFile,
  fork: handleFork,
  get_fork_messages: handleGetForkMessages,
  get_last_assistant_text: handleGetLastAssistantText,
  get_context_usage: handleGetContextUsage,
};

// =============================================================================
// ROUTING FUNCTION
// =============================================================================

/**
 * Route a session command to the appropriate handler.
 * Returns a response or undefined if no handler exists (unknown command).
 */
export function routeSessionCommand(
  session: AgentSession,
  command: any,
  getSessionInfo: (sessionId: string) => SessionInfo | undefined
): Promise<RpcResponse> | RpcResponse | undefined {
  const handler = sessionCommandHandlers[command.type];
  if (!handler) {
    return undefined;
  }
  return handler(session, command, getSessionInfo);
}

/**
 * Get list of supported session command types.
 */
export function getSupportedSessionCommands(): string[] {
  return Object.keys(sessionCommandHandlers);
}
