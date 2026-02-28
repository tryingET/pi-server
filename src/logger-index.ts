/**
 * Structured Logging System - Public API
 *
 * Re-exports all logger types and utilities for convenience.
 * Import from this file to use the logging system.
 *
 * @example
 * ```typescript
 * import { ConsoleLogger, CompositeLogger } from "./logger-index.js";
 *
 * const logger = new ConsoleLogger({ level: "debug" });
 * logger.info("Server started", { port: 3141 });
 * ```
 */

// Core types
export type { LogLevel, LogEntry, Logger } from "./logger-types.js";

// Constants
export { LOG_LEVEL_VALUES } from "./logger-types.js";

// Base class
export { BaseLogger } from "./logger-types.js";

// Built-in loggers
export { NoOpLogger, ConsoleLogger, CompositeLogger } from "./logger-types.js";
