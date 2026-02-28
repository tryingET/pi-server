/**
 * Metrics Emitter - Central point for emitting metrics.
 *
 * This is the main interface that pi-server code uses to record metrics.
 * It wraps the configured sink(s) and provides convenient helper methods.
 *
 * Usage:
 * ```typescript
 * const metrics = new MetricsEmitter(new CompositeSink([
 *   new MemorySink(),  // For get_metrics command
 *   new ConsoleSink(), // For development
 * ]));
 *
 * // In session creation:
 * metrics.counter(MetricNames.SESSIONS_CREATED_TOTAL, 1, { session_id: id });
 * metrics.gauge(MetricNames.SESSIONS_ACTIVE, manager.sessionCount);
 *
 * // In command execution:
 * const timer = metrics.startTimer(MetricNames.COMMANDS_DURATION_MS, tags);
 * await executeCommand(cmd);
 * timer.end();  // Records histogram value
 * ```
 */

import type {
  MetricEvent,
  MetricTags,
  MetricsSink,
  Span,
} from "./metrics-types.js";
import { NoOpSink } from "./metrics-types.js";

/**
 * Timer handle for duration tracking.
 */
export interface TimerHandle {
  /** End the timer and record the duration. */
  end(tags?: MetricTags): void;
  /** Abort the timer (don't record). */
  abort(): void;
}

/**
 * Metrics Emitter - provides convenient API for recording metrics.
 *
 * This class:
 * 1. Wraps a MetricsSink (or CompositeSink for multiple)
 * 2. Provides type-safe helper methods (counter, gauge, histogram, event)
 * 3. Handles timer-based duration tracking
 * 4. Provides tracing helpers (startSpan, endSpan)
 */
export class MetricsEmitter {
  private sink: MetricsSink;
  private prefix: string;
  private defaultTags: MetricTags;

  constructor(options: {
    sink?: MetricsSink;
    /** Prefix to add to all metric names (default: none) */
    prefix?: string;
    /** Tags to add to all metrics */
    defaultTags?: MetricTags;
  } = {}) {
    this.sink = options.sink ?? new NoOpSink();
    this.prefix = options.prefix ?? "";
    this.defaultTags = options.defaultTags ?? {};
  }

  /**
   * Get the underlying sink (for direct access if needed).
   */
  getSink(): MetricsSink {
    return this.sink;
  }

  /**
   * Replace the sink (hot-swap for configuration changes).
   */
  setSink(sink: MetricsSink): void {
    this.sink = sink;
  }

  // ==========================================================================
  // CORE METRIC METHODS
  // ==========================================================================

  /**
   * Record a counter increment.
   * Counters are monotonically increasing (e.g., requests_total).
   */
  counter(name: string, value = 1, tags?: MetricTags): void {
    this.emit({
      name: this.prefix + name,
      type: "counter",
      value,
      tags: this.mergeTags(tags),
    });
  }

  /**
   * Record a gauge value.
   * Gauges represent point-in-time values (e.g., active_sessions).
   */
  gauge(name: string, value: number, tags?: MetricTags): void {
    this.emit({
      name: this.prefix + name,
      type: "gauge",
      value,
      tags: this.mergeTags(tags),
    });
  }

  /**
   * Record a histogram value.
   * Histograms track distributions (e.g., request_duration_ms).
   */
  histogram(name: string, value: number, tags?: MetricTags, buckets?: number[]): void {
    this.emit({
      name: this.prefix + name,
      type: "histogram",
      value,
      tags: this.mergeTags(tags),
      buckets,
    });
  }

  /**
   * Record an event.
   * Events are single occurrences with optional data (e.g., session_created).
   */
  event(name: string, tags?: MetricTags, data?: MetricTags): void {
    this.emit({
      name: this.prefix + name,
      type: "event",
      tags: { ...this.mergeTags(tags), ...data },
    });
  }

  /**
   * Emit a raw metric event.
   * Use helper methods (counter, gauge, etc.) for most cases.
   */
  emit(event: MetricEvent): void {
    const fullEvent: MetricEvent = {
      ...event,
      timestamp: event.timestamp ?? Date.now(),
    };

    try {
      this.sink.record(fullEvent);
    } catch (error) {
      // Don't let metrics break the application
      console.error(`[MetricsEmitter] Failed to record metric '${event.name}':`, error);
    }
  }

  // ==========================================================================
  // TIMERS
  // ==========================================================================

  /**
   * Start a timer that records a histogram value when ended.
   *
   * @example
   * ```typescript
   * const timer = metrics.startTimer("command_duration_ms", { command: "prompt" });
   * await executeCommand(cmd);
   * timer.end({ success: true });
   * ```
   */
  startTimer(name: string, tags?: MetricTags, buckets?: number[]): TimerHandle {
    const startTime = Date.now();
    const mergedTags = this.mergeTags(tags);
    let recorded = false;

    return {
      end: (extraTags?: MetricTags) => {
        if (recorded) return;
        recorded = true;

        const duration = Date.now() - startTime;
        this.histogram(name, duration, { ...mergedTags, ...extraTags }, buckets);
      },

      abort: () => {
        recorded = true; // Don't record on abort
      },
    };
  }

  /**
   * Time an async function and record the duration.
   *
   * @example
   * ```typescript
   * const result = await metrics.timeAsync("command_duration_ms", async () => {
   *   return await executeCommand(cmd);
   * }, { command: "prompt" });
   * ```
   */
  async timeAsync<T>(
    name: string,
    fn: () => Promise<T>,
    tags?: MetricTags,
    buckets?: number[]
  ): Promise<T> {
    const timer = this.startTimer(name, tags, buckets);
    try {
      const result = await fn();
      timer.end({ success: true });
      return result;
    } catch (error) {
      timer.end({ success: false, error: error instanceof Error ? error.message : "unknown" });
      throw error;
    }
  }

  // ==========================================================================
  // TRACING
  // ==========================================================================

  /**
   * Start a trace span.
   * Returns undefined if tracing not supported by sink.
   */
  startSpan(name: string, parent?: Span): Span | undefined {
    if (!this.sink.startSpan) return undefined;
    try {
      return this.sink.startSpan(name, parent);
    } catch (error) {
      console.error(`[MetricsEmitter] Failed to start span '${name}':`, error);
      return undefined;
    }
  }

  /**
   * End a trace span.
   */
  endSpan(span: Span, error?: Error): void {
    if (!this.sink.endSpan) return;
    try {
      this.sink.endSpan(span, error);
    } catch (err) {
      console.error(`[MetricsEmitter] Failed to end span '${span.name}':`, err);
    }
  }

  /**
   * Time an async function with tracing.
   * Creates a span that covers the function execution.
   */
  async traceAsync<T>(
    name: string,
    fn: () => Promise<T>,
    parent?: Span
  ): Promise<T> {
    const span = this.startSpan(name, parent);
    try {
      const result = await fn();
      if (span) this.endSpan(span);
      return result;
    } catch (error) {
      if (span) this.endSpan(span, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Flush any buffered metrics.
   * Called during graceful shutdown.
   */
  async flush(): Promise<void> {
    if (!this.sink.flush) return;
    try {
      await this.sink.flush();
    } catch (error) {
      console.error("[MetricsEmitter] Failed to flush:", error);
    }
  }

  /**
   * Dispose the emitter and underlying sink.
   */
  async dispose(): Promise<void> {
    await this.flush();
    if (this.sink.dispose) {
      try {
        await this.sink.dispose();
      } catch (error) {
        console.error("[MetricsEmitter] Failed to dispose sink:", error);
      }
    }
  }

  /**
   * Get metrics from the underlying sink (if supported).
   */
  getMetrics(): Record<string, unknown> | undefined {
    return this.sink.getMetrics?.();
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  private mergeTags(tags?: MetricTags): MetricTags {
    if (!tags) return { ...this.defaultTags };
    if (Object.keys(this.defaultTags).length === 0) return tags;
    return { ...this.defaultTags, ...tags };
  }
}

// =============================================================================
// GLOBAL INSTANCE (OPTIONAL)
// =============================================================================

/**
 * Global metrics instance.
 * Use this for convenience, or create your own MetricsEmitter instances.
 *
 * @example
 * ```typescript
 * // In server startup:
 * setGlobalMetrics(new MetricsEmitter({
 *   sink: new CompositeSink([
 *     new MemorySink(),
 *     new PrometheusSink(),
 *   ]),
 * }));
 *
 * // In handlers:
 * globalMetrics.counter(MetricNames.COMMANDS_TOTAL, 1, { command: "prompt" });
 * ```
 */
let globalMetrics: MetricsEmitter | null = null;

export function getGlobalMetrics(): MetricsEmitter | null {
  return globalMetrics;
}

export function setGlobalMetrics(emitter: MetricsEmitter): void {
  globalMetrics = emitter;
}

export function requireGlobalMetrics(): MetricsEmitter {
  if (!globalMetrics) {
    throw new Error("Global metrics not initialized. Call setGlobalMetrics() first.");
  }
  return globalMetrics;
}
