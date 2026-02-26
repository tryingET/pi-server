/**
 * Command Classification - unified source of truth for command behavior.
 *
 * This module consolidates all command classification logic that was
 * previously scattered across multiple modules. Single source of truth
 * prevents drift and makes adding new commands easier.
 *
 * Classification dimensions:
 * - Timeout policy: short (30s), long (5min), or none (uncancellable)
 * - Mutation: does the command change session state?
 */

// =============================================================================
// TIMEOUT CLASSIFICATION
// =============================================================================

/**
 * Commands that should have shorter timeout (30 seconds).
 * These are fast operations that don't involve LLM calls.
 */
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
 * Commands that should not use command timeout (cannot be safely cancelled).
 * These have side effects that must complete once started.
 */
const NO_TIMEOUT_COMMANDS = new Set([
  "create_session", // Session creation is atomic
]);

/**
 * Get the timeout policy for a command type.
 * @returns Timeout in ms, or null for uncancellable commands
 */
export function getCommandTimeoutPolicy(
  commandType: string,
  options?: {
    defaultTimeoutMs?: number;
    shortTimeoutMs?: number;
  }
): number | null {
  if (NO_TIMEOUT_COMMANDS.has(commandType)) {
    return null;
  }

  const defaultTimeout = options?.defaultTimeoutMs ?? 5 * 60 * 1000;
  const shortTimeout = options?.shortTimeoutMs ?? 30 * 1000;

  return SHORT_TIMEOUT_COMMANDS.has(commandType) ? shortTimeout : defaultTimeout;
}

/**
 * Check if a command has a short timeout.
 */
export function isShortTimeoutCommand(commandType: string): boolean {
  return SHORT_TIMEOUT_COMMANDS.has(commandType);
}

/**
 * Check if a command cannot be timed out.
 */
export function isNoTimeoutCommand(commandType: string): boolean {
  return NO_TIMEOUT_COMMANDS.has(commandType);
}

// =============================================================================
// MUTATION CLASSIFICATION
// =============================================================================

/**
 * Commands that don't mutate session state (read-only).
 * These don't advance the session version on success.
 */
const READ_ONLY_COMMANDS = new Set([
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
  "switch_session", // Switches client focus, doesn't change session
]);

/**
 * Commands that appear to target a session but are handled specially.
 * These don't count as session mutations for version purposes.
 */
const SPECIAL_SESSION_COMMANDS = new Set([
  "extension_ui_response", // Handled by ExtensionUIManager, not session
]);

/**
 * Check if a command type mutates session state.
 * Mutating commands advance the session version.
 */
export function isMutationCommand(commandType: string): boolean {
  if (READ_ONLY_COMMANDS.has(commandType)) return false;
  if (SPECIAL_SESSION_COMMANDS.has(commandType)) return false;
  return true;
}

/**
 * Check if a command is read-only.
 */
export function isReadOnlyCommand(commandType: string): boolean {
  return READ_ONLY_COMMANDS.has(commandType);
}

// =============================================================================
// COMBINED QUERIES
// =============================================================================

/**
 * Full classification of a command type.
 */
export interface CommandClassification {
  /** Timeout in milliseconds, or null for uncancellable */
  timeoutMs: number | null;
  /** Whether this is a short timeout command */
  isShortTimeout: boolean;
  /** Whether this command can be timed out */
  isCancellable: boolean;
  /** Whether this command mutates session state */
  isMutation: boolean;
  /** Whether this command is read-only */
  isReadOnly: boolean;
}

/**
 * Get full classification for a command type.
 */
export function classifyCommand(
  commandType: string,
  options?: {
    defaultTimeoutMs?: number;
    shortTimeoutMs?: number;
  }
): CommandClassification {
  const timeoutMs = getCommandTimeoutPolicy(commandType, options);
  return {
    timeoutMs,
    isShortTimeout: isShortTimeoutCommand(commandType),
    isCancellable: timeoutMs !== null,
    isMutation: isMutationCommand(commandType),
    isReadOnly: isReadOnlyCommand(commandType),
  };
}
