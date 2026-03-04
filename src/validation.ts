/**
 * Input validation for RPC commands.
 *
 * Validates command structure before processing to prevent:
 * - Missing required fields
 * - Invalid field types
 * - Malformed requests
 */

export interface ValidationError {
  field: string;
  message: string;
}

import fs from "fs";
import path from "path";
import { SYNTHETIC_ID_PREFIX } from "./command-replay-store.js";

const MAX_PROMPT_MESSAGE_LENGTH = 200_000;
const MAX_BASH_COMMAND_LENGTH = 20_000;
const MAX_SESSION_NAME_LENGTH = 256;
const MAX_COMMAND_ID_LENGTH = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_REQUEST_ID_LENGTH = 256;
const MAX_DEPENDENCIES = 32;
const MAX_HISTORY_QUERY_LIMIT = 500;

/** Valid characters for requestId (alphanumeric, colon, dash, underscore). */
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9:_-]+$/;

/** Dangerous path patterns that could allow traversal or injection. */
const DANGEROUS_PATH_PATTERNS = [/\.\./, /^~/, /\0/];

/** Maximum path length to prevent abuse. */
const MAX_PATH_LENGTH = 4096;

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/**
 * Resolve to canonical path when possible (follows symlinks).
 * Falls back to absolute normalized path when path/parents don't exist.
 */
function resolveCanonicalPath(candidatePath: string): string {
  const resolved = path.resolve(candidatePath);

  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // If the full path doesn't exist yet, resolve the parent directory
    // to collapse symlinks and then re-attach the basename.
    const dir = path.dirname(resolved);
    const base = path.basename(resolved);
    try {
      const realDir = fs.realpathSync.native(dir);
      return path.join(realDir, base);
    } catch {
      return resolved;
    }
  }
}

/**
 * Check if a path contains dangerous components.
 * Returns error message if dangerous, null if safe.
 */
function validatePath(path: string, fieldName: string): string | null {
  if (path.length > MAX_PATH_LENGTH) {
    return `${fieldName} too long (max ${MAX_PATH_LENGTH} chars)`;
  }
  for (const pattern of DANGEROUS_PATH_PATTERNS) {
    if (pattern.test(path)) {
      return `${fieldName} contains potentially dangerous path components`;
    }
  }
  return null;
}

/**
 * Validate that a session path is within allowed directories.
 * This prevents path traversal attacks when loading sessions.
 *
 * Allowed directories:
 * - ~/.pi/agent/sessions/ (default session storage)
 * - Project-local .pi/sessions/ directories
 *
 * @param sessionPath - The path to validate
 * @param allowedDirs - Optional array of allowed directories (defaults to standard locations)
 * @returns Error message if invalid, null if valid
 */
export function validateSessionPath(sessionPath: string, allowedDirs?: string[]): string | null {
  // First check for dangerous path components
  const pathError = validatePath(sessionPath, "sessionPath");
  if (pathError) return pathError;

  // Require absolute path
  if (!path.isAbsolute(sessionPath)) {
    return "sessionPath must be an absolute path";
  }

  // Resolve to canonical path (removes . and .. components; resolves symlinks when possible)
  let resolvedPath: string;
  try {
    resolvedPath = path.resolve(sessionPath);
  } catch {
    return "sessionPath could not be resolved";
  }
  const canonicalPath = resolveCanonicalPath(resolvedPath);

  // Default allowed directories
  const home = process.env.HOME ?? "";
  const defaultAllowedDirs = [path.join(home, ".pi", "agent", "sessions")];

  // Check if path ends with .jsonl/.json (session file extension)
  // Validate both resolved and canonical forms to avoid extension-smuggling through symlinks.
  const hasAllowedExtension = (value: string) =>
    value.endsWith(".jsonl") || value.endsWith(".json");
  if (!hasAllowedExtension(resolvedPath) || !hasAllowedExtension(canonicalPath)) {
    return "sessionPath must point to a .jsonl or .json session file";
  }

  // Use provided allowed dirs or defaults
  const dirsToCheck = allowedDirs ?? defaultAllowedDirs;

  // Check if canonical path is under an allowed directory
  for (const allowedDir of dirsToCheck) {
    const canonicalAllowed = resolveCanonicalPath(allowedDir);
    if (
      canonicalPath.startsWith(canonicalAllowed + path.sep) ||
      canonicalPath === canonicalAllowed
    ) {
      return null; // Valid path
    }
  }

  // Also allow any .pi/sessions directory (project-local)
  const pathParts = canonicalPath.split(path.sep);
  const piSessionsIndex = pathParts.findIndex(
    (part, i) => part === ".pi" && pathParts[i + 1] === "sessions"
  );
  if (piSessionsIndex !== -1) {
    return null; // Valid project-local path
  }

  return `sessionPath must be under an allowed session directory (e.g., ~/.pi/agent/sessions/ or .pi/sessions/)`;
}

/**
 * Check if a command ID uses a reserved prefix.
 * Client-provided IDs starting with reserved prefixes are rejected.
 */
function isReservedIdPrefix(id: string): boolean {
  return id.startsWith(SYNTHETIC_ID_PREFIX);
}

const EXTENSION_UI_RESPONSE_METHODS = new Set([
  "select",
  "confirm",
  "input",
  "editor",
  "interview",
  "cancelled",
]);

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
  "get_tree",
  "navigate_tree",
  "get_last_assistant_text",
  "get_context_usage",
]);

// Server commands that don't require sessionId
const SERVER_COMMANDS = new Set([
  "list_sessions",
  "create_session",
  "delete_session",
  "switch_session",
  "get_metrics",
  "health_check",
  "get_startup_recovery",
  "get_command_history",
  // ADR-0007: Session persistence
  "list_stored_sessions",
  "load_session",
]);

const ALL_COMMANDS = new Set([...SESSION_COMMANDS, ...SERVER_COMMANDS]);

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

  if ("id" in cmd && (typeof cmd.id !== "string" || cmd.id.trim().length === 0)) {
    errors.push({ field: "id", message: "Must be a non-empty string if provided" });
  } else if (typeof cmd.id === "string" && cmd.id.length > MAX_COMMAND_ID_LENGTH) {
    errors.push({ field: "id", message: `Too long (max ${MAX_COMMAND_ID_LENGTH} chars)` });
  } else if (typeof cmd.id === "string" && isReservedIdPrefix(cmd.id)) {
    errors.push({ field: "id", message: `Cannot use reserved prefix '${SYNTHETIC_ID_PREFIX}'` });
  }

  if ("idempotencyKey" in cmd) {
    if (typeof cmd.idempotencyKey !== "string" || cmd.idempotencyKey.trim().length === 0) {
      errors.push({ field: "idempotencyKey", message: "Must be a non-empty string if provided" });
    } else if (cmd.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      errors.push({
        field: "idempotencyKey",
        message: `Too long (max ${MAX_IDEMPOTENCY_KEY_LENGTH} chars)`,
      });
    }
  }

  if ("dependsOn" in cmd) {
    if (!Array.isArray(cmd.dependsOn)) {
      errors.push({ field: "dependsOn", message: "Must be an array of command IDs" });
    } else {
      if (cmd.dependsOn.length > MAX_DEPENDENCIES) {
        errors.push({
          field: "dependsOn",
          message: `Too many dependencies (max ${MAX_DEPENDENCIES})`,
        });
      }
      for (let i = 0; i < cmd.dependsOn.length; i++) {
        const dep = cmd.dependsOn[i];
        if (typeof dep !== "string" || dep.trim().length === 0) {
          errors.push({
            field: `dependsOn[${i}]`,
            message: "Must be a non-empty command ID string",
          });
        }
      }
      if (cmd.dependsOn.length > 0 && typeof cmd.id !== "string") {
        errors.push({ field: "id", message: "Required when dependsOn is provided" });
      }
    }
  }

  if ("ifSessionVersion" in cmd) {
    if (
      typeof cmd.ifSessionVersion !== "number" ||
      !Number.isInteger(cmd.ifSessionVersion) ||
      cmd.ifSessionVersion < 0
    ) {
      errors.push({ field: "ifSessionVersion", message: "Must be a non-negative integer" });
    }
  }

  if (typeof cmd.type === "string" && !ALL_COMMANDS.has(cmd.type)) {
    errors.push({ field: "type", message: `Unknown command type '${cmd.type}'` });
  }

  // If it's a session command, sessionId is required
  if (typeof cmd.type === "string" && SESSION_COMMANDS.has(cmd.type)) {
    if (
      !("sessionId" in cmd) ||
      typeof cmd.sessionId !== "string" ||
      cmd.sessionId.trim().length === 0
    ) {
      errors.push({
        field: "sessionId",
        message: "Session commands must have a non-empty string 'sessionId'",
      });
    }
  }

  if (
    "ifSessionVersion" in cmd &&
    typeof cmd.type === "string" &&
    !SESSION_COMMANDS.has(cmd.type) &&
    cmd.type !== "delete_session"
  ) {
    errors.push({
      field: "ifSessionVersion",
      message: "Only supported for session-targeted commands",
    });
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
      if (
        "sessionId" in cmd &&
        (typeof cmd.sessionId !== "string" || cmd.sessionId.trim().length === 0)
      ) {
        errors.push({ field: "sessionId", message: "Must be a non-empty string if provided" });
      }
      if ("cwd" in cmd && typeof cmd.cwd !== "string") {
        errors.push({ field: "cwd", message: "Must be a string if provided" });
      }
      break;

    case "delete_session":
    case "switch_session":
      if (typeof cmd.sessionId !== "string" || cmd.sessionId.trim().length === 0) {
        errors.push({ field: "sessionId", message: "Required non-empty string" });
      }
      break;

    case "get_command_history": {
      if (
        "sessionIdFilter" in cmd &&
        (typeof cmd.sessionIdFilter !== "string" || cmd.sessionIdFilter.trim().length === 0)
      ) {
        errors.push({
          field: "sessionIdFilter",
          message: "Must be a non-empty string if provided",
        });
      }

      if (
        "commandId" in cmd &&
        (typeof cmd.commandId !== "string" || cmd.commandId.trim().length === 0)
      ) {
        errors.push({ field: "commandId", message: "Must be a non-empty string if provided" });
      } else if (
        typeof cmd.commandId === "string" &&
        cmd.commandId.length > MAX_COMMAND_ID_LENGTH
      ) {
        errors.push({
          field: "commandId",
          message: `Too long (max ${MAX_COMMAND_ID_LENGTH} chars)`,
        });
      }

      if ("fromTimestamp" in cmd) {
        if (
          typeof cmd.fromTimestamp !== "number" ||
          !Number.isInteger(cmd.fromTimestamp) ||
          cmd.fromTimestamp < 0
        ) {
          errors.push({
            field: "fromTimestamp",
            message: "Must be a non-negative integer timestamp",
          });
        }
      }

      if ("toTimestamp" in cmd) {
        if (
          typeof cmd.toTimestamp !== "number" ||
          !Number.isInteger(cmd.toTimestamp) ||
          cmd.toTimestamp < 0
        ) {
          errors.push({
            field: "toTimestamp",
            message: "Must be a non-negative integer timestamp",
          });
        }
      }

      if (
        typeof cmd.fromTimestamp === "number" &&
        typeof cmd.toTimestamp === "number" &&
        cmd.fromTimestamp > cmd.toTimestamp
      ) {
        errors.push({
          field: "fromTimestamp",
          message: "Must be less than or equal to toTimestamp",
        });
      }

      if ("limit" in cmd) {
        if (typeof cmd.limit !== "number" || !Number.isInteger(cmd.limit)) {
          errors.push({ field: "limit", message: "Must be an integer if provided" });
        } else if (cmd.limit <= 0 || cmd.limit > MAX_HISTORY_QUERY_LIMIT) {
          errors.push({
            field: "limit",
            message: `Must be between 1 and ${MAX_HISTORY_QUERY_LIMIT}`,
          });
        }
      }
      break;
    }

    case "prompt":
      if (!cmd.message || typeof cmd.message !== "string") {
        errors.push({ field: "message", message: "Required string" });
      } else if (cmd.message.length > MAX_PROMPT_MESSAGE_LENGTH) {
        errors.push({
          field: "message",
          message: `Too long (max ${MAX_PROMPT_MESSAGE_LENGTH} chars)`,
        });
      }
      break;

    case "steer":
    case "follow_up":
      if (!cmd.message || typeof cmd.message !== "string") {
        errors.push({ field: "message", message: "Required string" });
      } else if (cmd.message.length > MAX_PROMPT_MESSAGE_LENGTH) {
        errors.push({
          field: "message",
          message: `Too long (max ${MAX_PROMPT_MESSAGE_LENGTH} chars)`,
        });
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
      } else if (cmd.command.length > MAX_BASH_COMMAND_LENGTH) {
        errors.push({
          field: "command",
          message: `Too long (max ${MAX_BASH_COMMAND_LENGTH} chars)`,
        });
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
      } else {
        if (cmd.requestId.length > MAX_REQUEST_ID_LENGTH) {
          errors.push({
            field: "requestId",
            message: `Too long (max ${MAX_REQUEST_ID_LENGTH} chars)`,
          });
        }
        if (!REQUEST_ID_PATTERN.test(cmd.requestId)) {
          errors.push({
            field: "requestId",
            message: "Must contain only alphanumeric characters, colons, underscores, and dashes",
          });
        }
      }
      if (!cmd.response || typeof cmd.response !== "object") {
        errors.push({ field: "response", message: "Required object" });
      } else {
        const response = cmd.response as Record<string, unknown>;
        if (
          typeof response.method !== "string" ||
          !EXTENSION_UI_RESPONSE_METHODS.has(response.method)
        ) {
          errors.push({
            field: "response.method",
            message: "Must be one of: select, confirm, input, editor, interview, cancelled",
          });
        }
      }
      break;

    case "fork":
      if (!cmd.entryId || typeof cmd.entryId !== "string") {
        errors.push({ field: "entryId", message: "Required string" });
      }
      break;

    case "navigate_tree":
      if (!cmd.targetId || typeof cmd.targetId !== "string") {
        errors.push({ field: "targetId", message: "Required string" });
      }
      if ("options" in cmd) {
        if (!cmd.options || typeof cmd.options !== "object") {
          errors.push({ field: "options", message: "Must be an object if provided" });
        } else {
          const options = cmd.options as Record<string, unknown>;
          if ("summarize" in options && typeof options.summarize !== "boolean") {
            errors.push({ field: "options.summarize", message: "Must be a boolean if provided" });
          }
          if ("customInstructions" in options && typeof options.customInstructions !== "string") {
            errors.push({
              field: "options.customInstructions",
              message: "Must be a string if provided",
            });
          }
          if (
            "replaceInstructions" in options &&
            typeof options.replaceInstructions !== "boolean"
          ) {
            errors.push({
              field: "options.replaceInstructions",
              message: "Must be a boolean if provided",
            });
          }
          if ("label" in options && typeof options.label !== "string") {
            errors.push({ field: "options.label", message: "Must be a string if provided" });
          }
        }
      }
      break;

    case "switch_session_file":
      if (!cmd.sessionPath || typeof cmd.sessionPath !== "string") {
        errors.push({ field: "sessionPath", message: "Required string" });
      } else {
        const pathError = validatePath(cmd.sessionPath, "sessionPath");
        if (pathError) {
          errors.push({ field: "sessionPath", message: pathError });
        }
      }
      break;

    case "set_session_name":
      if (!cmd.name || typeof cmd.name !== "string") {
        errors.push({ field: "name", message: "Required string" });
      } else if (cmd.name.length > MAX_SESSION_NAME_LENGTH) {
        errors.push({ field: "name", message: `Too long (max ${MAX_SESSION_NAME_LENGTH} chars)` });
      } else if (hasControlCharacters(cmd.name)) {
        errors.push({ field: "name", message: "Must not contain control characters" });
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

    // ADR-0007: Session persistence
    case "load_session":
      if (!cmd.sessionPath || typeof cmd.sessionPath !== "string") {
        errors.push({ field: "sessionPath", message: "Required string" });
      } else {
        const pathError = validatePath(cmd.sessionPath, "sessionPath");
        if (pathError) {
          errors.push({ field: "sessionPath", message: pathError });
        }
      }
      if (
        "sessionId" in cmd &&
        (typeof cmd.sessionId !== "string" || cmd.sessionId.trim().length === 0)
      ) {
        errors.push({ field: "sessionId", message: "Must be a non-empty string if provided" });
      }
      break;
  }

  return errors;
}

/**
 * Format validation errors as a human-readable string.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.field}: ${e.message}`).join("; ");
}
