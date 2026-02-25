/**
 * Input validation for RPC commands.
 *
 * Validates command structure before processing to prevent:
 * - Missing required fields
 * - Invalid field types
 * - Malformed requests
 */

import type { RpcCommand } from "./types.js";

export interface ValidationError {
  field: string;
  message: string;
}

// Session commands that require sessionId
const SESSION_COMMANDS = new Set([
  "extension_ui_response",
  "get_available_models",
  "get_commands",
  "get_skills",
  "get_tools",
  "list_session_files",
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "get_state",
  "get_messages",
  "set_model",
  "cycle_model",
  "set_thinking_level",
  "cycle_thinking_level",
  "compact",
  "abort_compaction",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "bash",
  "abort_bash",
  "get_session_stats",
  "set_session_name",
  "export_html",
  "new_session",
  "switch_session_file",
  "fork",
  "get_fork_messages",
  "get_last_assistant_text",
  "get_context_usage",
]);

/**
 * Validate a command has required fields.
 * Returns array of errors (empty if valid).
 */
export function validateCommand(command: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  // Must be an object
  if (!command || typeof command !== "object") {
    return [{ field: "root", message: "Command must be an object" }];
  }

  const cmd = command as Record<string, unknown>;

  // Must have type field
  if (!cmd.type || typeof cmd.type !== "string") {
    errors.push({ field: "type", message: "Command must have a string 'type' field" });
  }

  // If it's a session command, sessionId is required
  if (typeof cmd.type === "string" && SESSION_COMMANDS.has(cmd.type)) {
    if (!("sessionId" in cmd) || typeof cmd.sessionId !== "string" || !cmd.sessionId) {
      errors.push({ field: "sessionId", message: "Session commands must have a non-empty string 'sessionId'" });
    }
  }

  // Type-specific validation
  if (typeof cmd.type === "string") {
    errors.push(...validateCommandByType(cmd.type, cmd));
  }

  return errors;
}

/**
 * Type-specific validation for known command types.
 */
function validateCommandByType(type: string, cmd: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  switch (type) {
    case "create_session":
      if ("sessionId" in cmd && typeof cmd.sessionId !== "string") {
        errors.push({ field: "sessionId", message: "Must be a string if provided" });
      }
      if ("cwd" in cmd && typeof cmd.cwd !== "string") {
        errors.push({ field: "cwd", message: "Must be a string if provided" });
      }
      break;

    case "delete_session":
    case "switch_session":
      if (!cmd.sessionId) {
        errors.push({ field: "sessionId", message: "Required" });
      }
      break;

    case "prompt":
      if (!cmd.message || typeof cmd.message !== "string") {
        errors.push({ field: "message", message: "Required string" });
      }
      break;

    case "steer":
    case "follow_up":
      if (!cmd.message || typeof cmd.message !== "string") {
        errors.push({ field: "message", message: "Required string" });
      }
      break;

    case "set_model":
      if (!cmd.provider || typeof cmd.provider !== "string") {
        errors.push({ field: "provider", message: "Required string" });
      }
      if (!cmd.modelId || typeof cmd.modelId !== "string") {
        errors.push({ field: "modelId", message: "Required string" });
      }
      break;

    case "set_thinking_level":
      if (!cmd.level || !["none", "low", "medium", "high", "xhigh"].includes(cmd.level as string)) {
        errors.push({ field: "level", message: "Must be one of: none, low, medium, high, xhigh" });
      }
      break;

    case "bash":
      if (!cmd.command || typeof cmd.command !== "string") {
        errors.push({ field: "command", message: "Required string" });
      }
      break;

    case "compact":
      if ("customInstructions" in cmd && typeof cmd.customInstructions !== "string") {
        errors.push({ field: "customInstructions", message: "Must be a string if provided" });
      }
      break;

    case "extension_ui_response":
      if (!cmd.requestId || typeof cmd.requestId !== "string") {
        errors.push({ field: "requestId", message: "Required string" });
      }
      if (!cmd.response || typeof cmd.response !== "object") {
        errors.push({ field: "response", message: "Required object" });
      }
      break;

    case "fork":
      if (!cmd.entryId || typeof cmd.entryId !== "string") {
        errors.push({ field: "entryId", message: "Required string" });
      }
      break;

    case "switch_session_file":
      if (!cmd.sessionPath || typeof cmd.sessionPath !== "string") {
        errors.push({ field: "sessionPath", message: "Required string" });
      }
      break;

    case "set_session_name":
      if (!cmd.name || typeof cmd.name !== "string") {
        errors.push({ field: "name", message: "Required string" });
      }
      break;

    case "export_html":
      if ("outputPath" in cmd && typeof cmd.outputPath !== "string") {
        errors.push({ field: "outputPath", message: "Must be a string if provided" });
      }
      break;

    case "set_auto_compaction":
    case "set_auto_retry":
      if (typeof cmd.enabled !== "boolean") {
        errors.push({ field: "enabled", message: "Required boolean" });
      }
      break;

    case "cycle_model":
      if ("direction" in cmd && !["forward", "backward"].includes(cmd.direction as string)) {
        errors.push({ field: "direction", message: "Must be 'forward' or 'backward'" });
      }
      break;
  }

  return errors;
}

/**
 * Format validation errors as a human-readable string.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map(e => `${e.field}: ${e.message}`).join("; ");
}
