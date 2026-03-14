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
export type CommandSchedulingClass = "control" | "data" | "interrupt";
export type KnownCommandType = RpcCommand["type"];

export interface CommandContract {
  timeoutMode: TimeoutMode;
  abortability: Abortability;
  isReadOnly: boolean;
  isMutation: boolean;
  executionPlane: CommandExecutionPlane;
  historySensitivity: HistorySensitivity;
  schedulingClass: CommandSchedulingClass;
}

export interface RateLimitTarget {
  plane: CommandExecutionPlane;
  key: string;
}

// =============================================================================
// CONTRACT REGISTRY
// =============================================================================

function defineContract(
  contract: Omit<CommandContract, "historySensitivity">
): CommandContract {
  return {
    ...contract,
    historySensitivity: "hash",
  };
}

const SESSION_READ_CONTRACT = defineContract({
  timeoutMode: "short",
  abortability: "non_abortable",
  isReadOnly: true,
  isMutation: false,
  executionPlane: "data",
  schedulingClass: "control",
});

const SERVER_READ_CONTRACT = defineContract({
  timeoutMode: "short",
  abortability: "non_abortable",
  isReadOnly: true,
  isMutation: false,
  executionPlane: "control",
  schedulingClass: "control",
});

const SESSION_MUTATION_LONG_CONTRACT = defineContract({
  timeoutMode: "long",
  abortability: "abortable",
  isReadOnly: false,
  isMutation: true,
  executionPlane: "data",
  schedulingClass: "data",
});

const SESSION_MUTATION_NO_TIMEOUT_CONTRACT = defineContract({
  timeoutMode: "none",
  abortability: "non_abortable",
  isReadOnly: false,
  isMutation: true,
  executionPlane: "data",
  schedulingClass: "data",
});

const SESSION_MUTATION_SHORT_INTERRUPT_CONTRACT = defineContract({
  timeoutMode: "short",
  abortability: "non_abortable",
  isReadOnly: false,
  isMutation: true,
  executionPlane: "data",
  schedulingClass: "interrupt",
});

const SPECIAL_INTERRUPT_CONTRACT = defineContract({
  timeoutMode: "short",
  abortability: "non_abortable",
  isReadOnly: false,
  isMutation: false,
  executionPlane: "data",
  schedulingClass: "interrupt",
});

const CONTROL_MUTATION_NO_TIMEOUT_CONTRACT = defineContract({
  timeoutMode: "none",
  abortability: "non_abortable",
  isReadOnly: false,
  isMutation: true,
  executionPlane: "control",
  schedulingClass: "data",
});

export const COMMAND_CONTRACTS = {
  // Session commands
  extension_ui_response: SPECIAL_INTERRUPT_CONTRACT,
  get_available_models: SESSION_READ_CONTRACT,
  get_commands: SESSION_READ_CONTRACT,
  get_skills: SESSION_READ_CONTRACT,
  get_tools: SESSION_READ_CONTRACT,
  list_session_files: SESSION_READ_CONTRACT,
  prompt: SESSION_MUTATION_LONG_CONTRACT,
  steer: SESSION_MUTATION_LONG_CONTRACT,
  follow_up: SESSION_MUTATION_LONG_CONTRACT,
  abort: SESSION_MUTATION_SHORT_INTERRUPT_CONTRACT,
  get_state: SESSION_READ_CONTRACT,
  get_messages: SESSION_READ_CONTRACT,
  set_model: defineContract({
    timeoutMode: "none",
    abortability: "non_abortable",
    isReadOnly: false,
    isMutation: true,
    executionPlane: "data",
    schedulingClass: "data",
  }),
  cycle_model: defineContract({
    timeoutMode: "none",
    abortability: "non_abortable",
    isReadOnly: false,
    isMutation: true,
    executionPlane: "data",
    schedulingClass: "data",
  }),
  set_thinking_level: defineContract({
    timeoutMode: "none",
    abortability: "non_abortable",
    isReadOnly: false,
    isMutation: true,
    executionPlane: "data",
    schedulingClass: "data",
  }),
  cycle_thinking_level: defineContract({
    timeoutMode: "none",
    abortability: "non_abortable",
    isReadOnly: false,
    isMutation: true,
    executionPlane: "data",
    schedulingClass: "data",
  }),
  compact: SESSION_MUTATION_LONG_CONTRACT,
  abort_compaction: SESSION_MUTATION_SHORT_INTERRUPT_CONTRACT,
  set_auto_compaction: defineContract({
    timeoutMode: "none",
    abortability: "non_abortable",
    isReadOnly: false,
    isMutation: true,
    executionPlane: "data",
    schedulingClass: "data",
  }),
  set_auto_retry: defineContract({
    timeoutMode: "none",
    abortability: "non_abortable",
    isReadOnly: false,
    isMutation: true,
    executionPlane: "data",
    schedulingClass: "data",
  }),
  abort_retry: SESSION_MUTATION_SHORT_INTERRUPT_CONTRACT,
  bash: SESSION_MUTATION_LONG_CONTRACT,
  abort_bash: SESSION_MUTATION_SHORT_INTERRUPT_CONTRACT,
  get_session_stats: SESSION_READ_CONTRACT,
  set_session_name: SESSION_MUTATION_NO_TIMEOUT_CONTRACT,
  export_html: SESSION_MUTATION_NO_TIMEOUT_CONTRACT,
  new_session: SESSION_MUTATION_LONG_CONTRACT,
  switch_session_file: SESSION_MUTATION_LONG_CONTRACT,
  fork: SESSION_MUTATION_LONG_CONTRACT,
  get_fork_messages: SESSION_READ_CONTRACT,
  get_tree: SESSION_READ_CONTRACT,
  navigate_tree: defineContract({
    timeoutMode: "none",
    abortability: "non_abortable",
    isReadOnly: false,
    isMutation: true,
    executionPlane: "data",
    schedulingClass: "data",
  }),
  get_last_assistant_text: SESSION_READ_CONTRACT,
  get_context_usage: SESSION_READ_CONTRACT,

  // Server commands
  list_sessions: SERVER_READ_CONTRACT,
  create_session: CONTROL_MUTATION_NO_TIMEOUT_CONTRACT,
  delete_session: CONTROL_MUTATION_NO_TIMEOUT_CONTRACT,
  switch_session: SERVER_READ_CONTRACT,
  get_metrics: SERVER_READ_CONTRACT,
  health_check: SERVER_READ_CONTRACT,
  get_startup_recovery: SERVER_READ_CONTRACT,
  get_command_history: SERVER_READ_CONTRACT,
  list_stored_sessions: SERVER_READ_CONTRACT,
  load_session: CONTROL_MUTATION_NO_TIMEOUT_CONTRACT,
} satisfies Record<KnownCommandType, CommandContract>;

const TARGETED_CONTROL_PLANE_COMMANDS = new Set<KnownCommandType>([
  "delete_session",
  "switch_session",
]);

const UNKNOWN_COMMAND_CONTRACT: CommandContract = defineContract({
  timeoutMode: "none",
  abortability: "non_abortable",
  isReadOnly: false,
  isMutation: true,
  executionPlane: "data",
  schedulingClass: "data",
});

// =============================================================================
// CONTRACT RESOLUTION
// =============================================================================

/**
 * Resolve the canonical command contract.
 */
export function getCommandContract(commandType: string): CommandContract {
  return COMMAND_CONTRACTS[commandType as KnownCommandType] ?? UNKNOWN_COMMAND_CONTRACT;
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
 */
export function getCommandExecutionPlane(commandType: string): CommandExecutionPlane {
  return getCommandContract(commandType).executionPlane;
}

/**
 * Resolve which scheduler class a command belongs to.
 */
export function getCommandSchedulingClass(commandType: string): CommandSchedulingClass {
  return getCommandContract(commandType).schedulingClass;
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

  if (command.sessionId && TARGETED_CONTROL_PLANE_COMMANDS.has(command.type as KnownCommandType)) {
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
  /** Which scheduler lane class the command belongs to */
  schedulingClass: CommandSchedulingClass;
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
    schedulingClass: contract.schedulingClass,
    historySensitivity: contract.historySensitivity,
  };
}
