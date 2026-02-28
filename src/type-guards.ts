/**
 * Type guards and accessor functions for RPC commands and responses.
 *
 * Extracted from types.ts to keep type definitions separate from runtime utilities.
 * These functions provide type-safe access to command fields and response discrimination.
 */

import type { SessionInfo } from "./types.js";
import type { RpcCommand, RpcResponse, RpcResponseBase, SessionCommand } from "./types.js";

// =============================================================================
// COMMAND ACCESSORS
// =============================================================================

/**
 * Get the optional command ID from any RpcCommand.
 */
export function getCommandId(cmd: RpcCommand): string | undefined {
  return cmd.id;
}

/**
 * Get the command type as a string.
 */
export function getCommandType(cmd: RpcCommand): string {
  return cmd.type;
}

/**
 * Get the sessionId from a command, if present.
 * Returns undefined for server commands that don't have sessionId.
 */
export function getSessionId(cmd: RpcCommand): string | undefined {
  if ("sessionId" in cmd) return cmd.sessionId;
  return undefined;
}

/**
 * Optional causal dependencies for command ordering.
 */
export function getCommandDependsOn(cmd: RpcCommand): string[] | undefined {
  return Array.isArray(cmd.dependsOn)
    ? cmd.dependsOn.filter((value): value is string => typeof value === "string")
    : undefined;
}

/**
 * Optional optimistic concurrency precondition.
 */
export function getCommandIfSessionVersion(cmd: RpcCommand): number | undefined {
  return typeof cmd.ifSessionVersion === "number" ? cmd.ifSessionVersion : undefined;
}

/**
 * Optional idempotency key for replay-safe command retries.
 */
export function getCommandIdempotencyKey(cmd: RpcCommand): string | undefined {
  return typeof cmd.idempotencyKey === "string" ? cmd.idempotencyKey : undefined;
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Type guard: true if command targets a session (has sessionId).
 */
export function isSessionCommand(cmd: RpcCommand): cmd is SessionCommand {
  return "sessionId" in cmd;
}

/**
 * Type guard: true if response is a successful create_session response.
 */
export function isCreateSessionResponse(response: RpcResponse): response is RpcResponseBase & {
  command: "create_session";
  success: true;
  data: { sessionId: string; sessionInfo: SessionInfo };
} {
  return response.success && response.command === "create_session";
}

/**
 * Type guard: true if response is a successful switch_session response.
 */
export function isSwitchSessionResponse(response: RpcResponse): response is RpcResponseBase & {
  command: "switch_session";
  success: true;
  data: { sessionInfo: SessionInfo };
} {
  return response.success && response.command === "switch_session";
}
