/**
 * Structured Logging System
 *
 * Design principles:
 * 1. Logger interface is minimal and focused on structured output
 * 2. Built-in implementations for common cases
 * 3. External packages can provide pino, winston, bunyan, etc.
 *
 * Similar to MetricsSink but for logging:
 * - MetricsSink: "Here's a metric event, do whatever you want"
 * - Logger: "Here's a log message with context, do whatever you want"
 */

// =============================================================================
// LOG LEVELS
// =============================================================================

/**
 * Log levels in order of severity.
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Log level severity values (higher = more severe).
 */
export const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

// =============================================================================
// LOG ENTRY
// =============================================================================

/**
 * A structured log entry.
 */
export interface LogEntry {
  /** Log level */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Timestamp (epoch ms) */
  timestamp: number;
  /** Additional context */
  context?: Record<string, unknown>;
  /** Error object (if any) */
  error?: Error;
  /** Source component/module */
  component?: string;
}

// =============================================================================
// LOGGER INTERFACE
// =============================================================================

/**
 * Logger - Interface for structured logging.
 *
 * Implementations can:
 * - Write to console (development)
 * - Write to files (production)
 * - Send to log aggregation services (Datadog, Loggly, etc.)
 * - Format as JSON (structured logging)
 * - Format as text (human-readable)
 *
 * @example
 * ```typescript
 * class PinoLogger implements Logger {
 *   private pino;
 *
 *   constructor(level: LogLevel) {
 *     this.pino = pino({ level });
 *   }
 *
 *   log(entry: LogEntry): void {
 *     this.pino[entry.level](entry.context || {}, entry.message);
 *   }
 * }
 * ```
 */
export interface Logger {
  /**
   * Log a message at trace level.
   */
  trace(message: string, context?: Record<string, unknown>): void;

  /**
   * Log a message at debug level.
   */
  debug(message: string, context?: Record<string, unknown>): void;

  /**
   * Log a message at info level.
   */
  info(message: string, context?: Record<string, unknown>): void;

  /**
   * Log a message at warn level.
   */
  warn(message: string, context?: Record<string, unknown>): void;

  /**
   * Log a message at error level.
   */
  error(message: string, context?: Record<string, unknown>): void;

  /**
   * Log a message at fatal level.
   */
  fatal(message: string, context?: Record<string, unknown>): void;

  /**
   * Log an error with context.
   */
  logError(message: string, error: Error, context?: Record<string, unknown>): void;

  /**
   * Create a child logger with additional context.
   */
  child(context: Record<string, unknown>): Logger;

  /**
   * Get current log level.
   */
  getLevel(): LogLevel;

  /**
   * Set log level.
   */
  setLevel(level: LogLevel): void;

  /**
   * Check if a level is enabled.
   */
  isLevelEnabled(level: LogLevel): boolean;

  /**
   * Clean up resources.
   */
  dispose?(): Promise<void> | void;
}

// =============================================================================
// BASE LOGGER (HELPER CLASS)
// =============================================================================

/**
 * BaseLogger - Abstract base class for loggers.
 * Provides level filtering and child logger creation.
 */
export abstract class BaseLogger implements Logger {
  protected level: LogLevel;
  protected baseContext: Record<string, unknown>;

  constructor(level: LogLevel = "info", baseContext: Record<string, unknown> = {}) {
    this.level = level;
    this.baseContext = baseContext;
  }

  abstract log(entry: LogEntry): void;

  trace(message: string, context?: Record<string, unknown>): void {
    if (this.isLevelEnabled("trace")) {
      this.log({ level: "trace", message, timestamp: Date.now(), context: this.mergeContext(context) });
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.isLevelEnabled("debug")) {
      this.log({ level: "debug", message, timestamp: Date.now(), context: this.mergeContext(context) });
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.isLevelEnabled("info")) {
      this.log({ level: "info", message, timestamp: Date.now(), context: this.mergeContext(context) });
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.isLevelEnabled("warn")) {
      this.log({ level: "warn", message, timestamp: Date.now(), context: this.mergeContext(context) });
    }
  }

  error(message: string, context?: Record<string, unknown>): void {
    if (this.isLevelEnabled("error")) {
      this.log({ level: "error", message, timestamp: Date.now(), context: this.mergeContext(context) });
    }
  }

  fatal(message: string, context?: Record<string, unknown>): void {
    if (this.isLevelEnabled("fatal")) {
      this.log({ level: "fatal", message, timestamp: Date.now(), context: this.mergeContext(context) });
    }
  }

  logError(message: string, error: Error, context?: Record<string, unknown>): void {
    if (this.isLevelEnabled("error")) {
      this.log({
        level: "error",
        message,
        timestamp: Date.now(),
        context: this.mergeContext(context),
        error,
      });
    }
  }

  child(context: Record<string, unknown>): Logger {
    // Create a new instance with merged context
    const ChildLoggerClass = this.constructor as new (level: LogLevel, ctx: Record<string, unknown>) => this;
    return new ChildLoggerClass(this.level, { ...this.baseContext, ...context });
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.level];
  }

  protected mergeContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!context) {
      return Object.keys(this.baseContext).length > 0 ? { ...this.baseContext } : undefined;
    }
    if (Object.keys(this.baseContext).length === 0) {
      return context;
    }
    return { ...this.baseContext, ...context };
  }
}

// =============================================================================
// BUILT-IN LOGGERS
// =============================================================================

/**
 * NoOpLogger - Discards all log messages.
 * Use this when logging is not needed.
 */
export class NoOpLogger extends BaseLogger {
  log(_entry: LogEntry): void {
    // Discard
  }

  child(_context: Record<string, unknown>): Logger {
    return this;
  }
}

/**
 * ConsoleLogger - Logs to console with optional JSON formatting.
 */
export class ConsoleLogger extends BaseLogger {
  private json: boolean;
  private component?: string;

  constructor(options: {
    level?: LogLevel;
    json?: boolean;
    component?: string;
    baseContext?: Record<string, unknown>;
  } = {}) {
    super(options.level ?? "info", options.baseContext ?? {});
    this.json = options.json ?? false;
    this.component = options.component;
  }

  log(entry: LogEntry): void {
    if (this.json) {
      this.logJson(entry);
    } else {
      this.logText(entry);
    }
  }

  private logText(entry: LogEntry): void {
    const timestamp = new Date(entry.timestamp).toISOString();
    const level = entry.level.toUpperCase().padEnd(5);
    const component = entry.component ?? this.component ?? "";
    const prefix = component ? `[${component}] ` : "";
    const contextStr = entry.context ? ` ${JSON.stringify(entry.context)}` : "";

    let message = `${timestamp} ${level} ${prefix}${entry.message}${contextStr}`;

    if (entry.error) {
      message += `\n  Error: ${entry.error.message}`;
      if (entry.error.stack) {
        message += `\n  ${entry.error.stack}`;
      }
    }

    // Use appropriate console method
    switch (entry.level) {
      case "trace":
      case "debug":
        console.debug(message);
        break;
      case "info":
        console.info(message);
        break;
      case "warn":
        console.warn(message);
        break;
      case "error":
      case "fatal":
        console.error(message);
        break;
    }
  }

  private logJson(entry: LogEntry): void {
    const output: Record<string, unknown> = {
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
    };

    if (entry.component ?? this.component) {
      output.component = entry.component ?? this.component;
    }

    if (entry.context) {
      Object.assign(output, entry.context);
    }

    if (entry.error) {
      output.error = {
        message: entry.error.message,
        stack: entry.error.stack,
      };
    }

    console.log(JSON.stringify(output));
  }

  child(context: Record<string, unknown>): Logger {
    return new ConsoleLogger({
      level: this.level,
      json: this.json,
      component: this.component,
      baseContext: { ...this.baseContext, ...context },
    });
  }
}

/**
 * CompositeLogger - Sends logs to multiple loggers.
 */
export class CompositeLogger implements Logger {
  private loggers: Logger[];

  constructor(loggers: Logger[]) {
    this.loggers = loggers;
  }

  trace(message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) {
      logger.trace(message, context);
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) {
      logger.debug(message, context);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) {
      logger.info(message, context);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) {
      logger.warn(message, context);
    }
  }

  error(message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) {
      logger.error(message, context);
    }
  }

  fatal(message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) {
      logger.fatal(message, context);
    }
  }

  logError(message: string, error: Error, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) {
      logger.logError(message, error, context);
    }
  }

  child(context: Record<string, unknown>): Logger {
    return new CompositeLogger(this.loggers.map((l) => l.child(context)));
  }

  getLevel(): LogLevel {
    // Return lowest level from all loggers
    let minLevel: LogLevel = "fatal";
    for (const logger of this.loggers) {
      const level = logger.getLevel();
      if (LOG_LEVEL_VALUES[level] < LOG_LEVEL_VALUES[minLevel]) {
        minLevel = level;
      }
    }
    return minLevel;
  }

  setLevel(level: LogLevel): void {
    for (const logger of this.loggers) {
      logger.setLevel(level);
    }
  }

  isLevelEnabled(level: LogLevel): boolean {
    return this.loggers.some((l) => l.isLevelEnabled(level));
  }

  async dispose(): Promise<void> {
    await Promise.all(
      this.loggers.map(async (logger) => {
        try {
          await logger.dispose?.();
        } catch (err) {
          console.error("[CompositeLogger] Logger failed to dispose:", err);
        }
      })
    );
  }

  add(logger: Logger): void {
    this.loggers.push(logger);
  }

  remove(logger: Logger): boolean {
    const idx = this.loggers.indexOf(logger);
    if (idx !== -1) {
      this.loggers.splice(idx, 1);
      return true;
    }
    return false;
  }
}
