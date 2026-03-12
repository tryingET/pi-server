/**
 * Command Classification - unified source of truth for command behavior.
 *
 * This module consolidates all command classification logic that was
 * previously scattered across multiple modules. Single source of truth
 * prevents drift and makes adding new commands easier.
 *
 * Classification dimensions:
 * - Timeout policy: short (30s), long (5min), or none (non-cancellable)
 * - Abortability: whether timeout can be paired with a best-effort abort hook
 * - Mutation: does the command change session/server state?
 * - Execution plane: control-plane vs data-plane admission/rate limiting
 * - History sensitivity: how replay identity should be exposed outside runtime internals
 */

import type { RpcCommand } from "./types.js";

// =============================================================================
// CONTRACT TYPES
// =============================================================================

export type TimeoutMode = "none" | "short" | "long";
export type Abortability = "abortable" | "non_abortable";
export type HistorySensitivity = "hash";
export type CommandExecutionPlane = "control" | "data";

export interface CommandContract {
  timeoutMode: TimeoutMode;
  abortability: Abortability;
  isReadOnly: boolean;
  isMutation: boolean;
  executionPlane: CommandExecutionPlane;
  historySensitivity: HistorySensitivity;
}

// =============================================================================
// CLASSIFICATION SETS
// =============================================================================

/**
 * Commands that don't mutate session/server state.
 * These don't advance the session version on success.
 */
const READ_ONLY_COMMANDS = new Set([
  // Session reads
  "get_state",
  "get_messages",
  "get_available_models",
  "get_commands",
  "get_skills",
  "get_tools",
  "list_session_files",
  "get_session_stats",
  "get_fork_messages",
  "get_tree",
  "get_last_assistant_text",
  "get_context_usage",
  // Server/control reads
  "list_sessions",
  "switch_session", // Switches client focus, doesn't change session
  "get_metrics",
  "health_check",
  "get_startup_recovery",
  "get_command_history",
  "list_stored_sessions",
]);

/**
 * Commands that appear to target a session but are handled specially.
 * These don't count as session mutations for version purposes.
 */
const SPECIAL_SESSION_COMMANDS = new Set([
  "extension_ui_response", // Handled by ExtensionUIManager, not AgentSession state
]);

/**
 * Commands that operate on server/session registry control surfaces rather than
 * consuming a session's data-plane work budget.
 */
const CONTROL_PLANE_COMMANDS = new Set([
  "list_sessions",
  "create_session",
  "delete_session",
  "switch_session",
  "get_metrics",
  "health_check",
  "get_startup_recovery",
  "get_command_history",
  "list_stored_sessions",
  "load_session",
]);

/** Commands that target a specific session but should use a dedicated control bucket. */
const TARGETED_CONTROL_PLANE_COMMANDS = new Set(["delete_session", "switch_session"]);

/**
 * Commands with a real best-effort abort path.
 * Only these commands should be exposed to command timeout by default.
 */
const ABORTABLE_COMMANDS = new Set([
  "prompt",
  "steer",
  "follow_up",
  "compact",
  "bash",
  "new_session",
  "switch_session_file",
  "fork",
]);

/**
 * Commands that are quick, operationally safe, and should keep a short timeout
 * even though they are not long-running LLM/data-plane tasks.
 */
const EXPLICIT_SHORT_TIMEOUT_COMMANDS = new Set([
  "abort",
  "abort_compaction",
  "abort_retry",
  "abort_bash",
  "extension_ui_response",
]);

/**
 * Commands that must never be timeout-wrapped because they can commit durable
 * mutations after the caller already received a terminal timeout response.
 */
const EXPLICIT_NO_TIMEOUT_COMMANDS = new Set([
  "create_session",
  "delete_session",
  "load_session",
  "set_session_name",
  "export_html",
]);

// =============================================================================
// CONTRACT RESOLUTION
// =============================================================================

/**
 * Resolve the canonical command contract.
 *
 * Default philosophy:
 * - read-only commands get short bounded timeouts
 * - abortable mutations get long timeouts plus best-effort abort hooks
 * - non-abortable mutations fail safe by default (no timeout wrapper)
 */
export function getCommandContract(commandType: string): CommandContract {
  const isReadOnly = READ_ONLY_COMMANDS.has(commandType);
  const isMutation = !isReadOnly && !SPECIAL_SESSION_COMMANDS.has(commandType);
  const executionPlane: CommandExecutionPlane = CONTROL_PLANE_COMMANDS.has(commandType)
    ? "control"
    : "data";
  const abortability: Abortability = ABORTABLE_COMMANDS.has(commandType)
    ? "abortable"
    : "non_abortable";

  let timeoutMode: TimeoutMode;
  if (EXPLICIT_NO_TIMEOUT_COMMANDS.has(commandType)) {
    timeoutMode = "none";
  } else if (EXPLICIT_SHORT_TIMEOUT_COMMANDS.has(commandType)) {
    timeoutMode = "short";
  } else if (isReadOnly) {
    timeoutMode = "short";
  } else if (abortability === "abortable") {
    timeoutMode = "long";
  } else {
    timeoutMode = "none";
  }

  return {
    timeoutMode,
    abortability,
    isReadOnly,
    isMutation,
    executionPlane,
    historySensitivity: "hash",
  };
}

// =============================================================================
// TIMEOUT CLASSIFICATION
// =============================================================================

/**
 * Get the timeout policy for a command type.
 * @returns Timeout in ms, or null for commands that must not be timeout-wrapped
 */
export function getCommandTimeoutPolicy(
  commandType: string,
  options?: {
    defaultTimeoutMs?: number;
    shortTimeoutMs?: number;
  }
): number | null {
  const contract = getCommandContract(commandType);
  const defaultTimeout = options?.defaultTimeoutMs ?? 5 * 60 * 1000;
  const shortTimeout = options?.shortTimeoutMs ?? 30 * 1000;

  switch (contract.timeoutMode) {
    case "none":
      return null;
    case "short":
      return shortTimeout;
    case "long":
      return defaultTimeout;
  }
}

/**
 * Check if a command has a short timeout.
 */
export function isShortTimeoutCommand(commandType: string): boolean {
  return getCommandContract(commandType).timeoutMode === "short";
}

/**
 * Check if a command cannot be timed out.
 */
export function isNoTimeoutCommand(commandType: string): boolean {
  return getCommandContract(commandType).timeoutMode === "none";
}

// =============================================================================
// MUTATION CLASSIFICATION
// =============================================================================

/**
 * Check if a command type mutates session/server state.
 * Mutating session commands advance the session version.
 */
export function isMutationCommand(commandType: string): boolean {
  return getCommandContract(commandType).isMutation;
}

/**
 * Check if a command is read-only.
 */
export function isReadOnlyCommand(commandType: string): boolean {
  return getCommandContract(commandType).isReadOnly;
}

/**
 * Resolve whether a command belongs to the control plane or data plane.
 *
 * Why this matters:
 * - control-plane operations (create/delete/switch/metrics/history) must remain
 *   operable even when a session's data-plane traffic is saturated
 * - data-plane operations should still be isolated per session
 */
export function getCommandExecutionPlane(commandType: string): CommandExecutionPlane {
  return getCommandContract(commandType).executionPlane;
}

export interface RateLimitTarget {
  plane: CommandExecutionPlane;
  key: string;
}

/**
 * Get the rate-limit bucket key for a command.
 *
 * Control-plane commands use dedicated buckets so runaway session traffic does
 * not block cleanup/inspection commands like delete_session.
 */
export function getRateLimitTarget(
  command: Pick<RpcCommand, "type"> & { sessionId?: string }
): RateLimitTarget {
  const plane = getCommandExecutionPlane(command.type);
  if (plane === "data") {
    return {
      plane,
      key: command.sessionId ?? "_server_data_",
    };
  }

  if (command.sessionId && TARGETED_CONTROL_PLANE_COMMANDS.has(command.type)) {
    return {
      plane,
      key: `control:${command.sessionId}`,
    };
  }

  return {
    plane,
    key: "_server_control_",
  };
}

// =============================================================================
// COMBINED QUERIES
// =============================================================================

/**
 * Full classification of a command type.
 */
export interface CommandClassification {
  /** Timeout in milliseconds, or null for non-timeout-wrapped commands */
  timeoutMs: number | null;
  /** Whether this is a short timeout command */
  isShortTimeout: boolean;
  /** Whether this command can be timed out */
  isCancellable: boolean;
  /** Whether timeout can be paired with a best-effort abort hook */
  abortability: Abortability;
  /** Whether this command mutates session/server state */
  isMutation: boolean;
  /** Whether this command is read-only */
  isReadOnly: boolean;
  /** Whether this command is control-plane or data-plane */
  executionPlane: CommandExecutionPlane;
  /** How replay identity should be exposed in history/diagnostic surfaces */
  historySensitivity: HistorySensitivity;
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
  const contract = getCommandContract(commandType);
  const timeoutMs = getCommandTimeoutPolicy(commandType, options);
  return {
    timeoutMs,
    isShortTimeout: contract.timeoutMode === "short",
    isCancellable: timeoutMs !== null,
    abortability: contract.abortability,
    isMutation: contract.isMutation,
    isReadOnly: contract.isReadOnly,
    executionPlane: contract.executionPlane,
    historySensitivity: contract.historySensitivity,
  };
}
