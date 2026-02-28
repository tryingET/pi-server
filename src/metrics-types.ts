/**
 * Pluggable Metrics System - ADR-0016
 *
 * Design principles:
 * 1. Core emits metrics events, doesn't know about backends
 * 2. Multiple sinks can be registered (fan-out)
 * 3. Sinks are responsible for their own formatting/transport
 * 4. Built-in sinks for common cases, external packages for everything else
 *
 * Similar to AuthProvider but for observability:
 * - AuthProvider: "Here's a connection, should I accept it?"
 * - MetricsSink: "Here's a metric event, do whatever you want with it"
 */

// =============================================================================
// CORE TYPES
// =============================================================================

/**
 * Metric value types.
 */
export type MetricValue = number | string | boolean;

/**
 * Tags for metric dimensionality.
 * These are key-value pairs that can be used for filtering/grouping.
 */
export type MetricTags = Record<string, MetricValue | undefined>;

/**
 * Types of metric events.
 *
 * - COUNTER: Monotonically increasing (requests_total, errors_total)
 * - GAUGE: Point-in-time value (active_sessions, memory_bytes)
 * - HISTOGRAM: Distribution of values (request_duration_ms)
 * - EVENT: Single occurrence with optional data (session_created, circuit_opened)
 */
export type MetricType = "counter" | "gauge" | "histogram" | "event";

/**
 * A single metric event.
 */
export interface MetricEvent {
  /** Metric name (e.g., "pi_server_commands_total") */
  name: string;
  /** Type of metric */
  type: MetricType;
  /** Numeric value (required for counter/gauge/histogram) */
  value?: number;
  /** Dimensionality tags */
  tags?: MetricTags;
  /** Timestamp (defaults to now) */
  timestamp?: number;
  /** For histograms: bucket boundaries (optional, sink may provide defaults) */
  buckets?: number[];
}

/**
 * A span for distributed tracing.
 * Spans form a tree structure representing request flow.
 */
export interface Span {
  /** Unique span ID */
  spanId: string;
  /** Parent span ID (if nested) */
  parentSpanId?: string;
  /** Trace ID (shared across all spans in a request) */
  traceId: string;
  /** Operation name */
  name: string;
  /** Start time (epoch ms) */
  startTime: number;
  /** End time (epoch ms, set when span ends) */
  endTime?: number;
  /** Tags */
  tags?: MetricTags;
  /** Whether span recorded an error */
  error?: boolean;
  /** Error message if error=true */
  errorMessage?: string;
}

// =============================================================================
// SINK INTERFACE
// =============================================================================

/**
 * MetricsSink - Interface for metric backends.
 *
 * Implementations can:
 * - Push to external systems (Prometheus push gateway, StatsD, Datadog)
 * - Expose endpoints (Prometheus /metrics)
 * - Write to files (JSON lines, CSV)
 * - Send to stdout (for log aggregation)
 * - Keep in memory (for get_metrics command)
 *
 * The sink receives ALL metric events and decides what to do with them.
 * Sinks can filter, aggregate, sample, or transform as needed.
 *
 * @example
 * ```typescript
 * // Custom Prometheus exporter
 * class PrometheusSink implements MetricsSink {
 *   private registry = new Registry();
 *
 *   record(event: MetricEvent): void {
 *     // Convert to Prometheus format
 *     const metric = this.registry.getOrAdd(event.name, event.type, event.tags);
 *     metric.observe(event.value);
 *   }
 *
 *   async expose(): Promise<string> {
 *     return await this.registry.metrics();
 *   }
 * }
 * ```
 */
export interface MetricsSink {
  /**
   * Record a metric event.
   * Called for every metric - implementation should be fast.
   */
  record(event: MetricEvent): void;

  /**
   * Start a new trace span.
   * Returns span ID that can be used to end the span.
   * Return undefined if tracing not supported.
   */
  startSpan?(name: string, parent?: Span): Span | undefined;

  /**
   * End a trace span.
   */
  endSpan?(span: Span, error?: Error): void;

  /**
   * Flush any buffered metrics.
   * Called during graceful shutdown.
   */
  flush?(): Promise<void>;

  /**
   * Clean up resources.
   */
  dispose?(): Promise<void> | void;

  /**
   * Optional: Get sink-specific metrics.
   * For /metrics endpoint or get_metrics command.
   */
  getMetrics?(): Record<string, unknown>;
}

// =============================================================================
// BUILT-IN SINKS
// =============================================================================

/**
 * NoOpSink - Discards all metrics.
 * Use this when metrics are not needed (default).
 */
export class NoOpSink implements MetricsSink {
  record(_event: MetricEvent): void {
    // Discard
  }
}

/**
 * ConsoleSink - Logs metrics to console.
 * Useful for development and debugging.
 */
export class ConsoleSink implements MetricsSink {
  constructor(
    private options: {
      /** Only log these metric names (if set) */
      filter?: Set<string>;
      /** Log to console.error instead of console.log */
      stderr?: boolean;
    } = {}
  ) {}

  record(event: MetricEvent): void {
    if (this.options.filter && !this.options.filter.has(event.name)) {
      return;
    }

    const log = this.options.stderr ? console.error : console.log;
    const tags = event.tags ? ` ${JSON.stringify(event.tags)}` : "";
    log(`[metrics] ${event.type}:${event.name}=${event.value ?? 1}${tags}`);
  }
}

/**
 * MemorySink - Stores metrics in memory for get_metrics command.
 * This is the current behavior - maintains counters/gauges in maps.
 *
 * Note: Not suitable for high-cardinality metrics (e.g., per-session counters).
 * Use with care in production.
 */
export class MemorySink implements MetricsSink {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, { sum: number; count: number; min: number; max: number }>();
  private events: Array<MetricEvent & { timestamp: number }> = [];
  private maxEvents = 1000;

  constructor(options: { maxEvents?: number } = {}) {
    this.maxEvents = options.maxEvents ?? 1000;
  }

  record(event: MetricEvent): void {
    const key = this.buildKey(event.name, event.tags);

    switch (event.type) {
      case "counter":
        this.counters.set(key, (this.counters.get(key) ?? 0) + (event.value ?? 1));
        break;

      case "gauge":
        this.gauges.set(key, event.value ?? 0);
        break;

      case "histogram": {
        const hist = this.histograms.get(key) ?? { sum: 0, count: 0, min: Infinity, max: -Infinity };
        const val = event.value ?? 0;
        hist.sum += val;
        hist.count++;
        hist.min = Math.min(hist.min, val);
        hist.max = Math.max(hist.max, val);
        this.histograms.set(key, hist);
        break;
      }

      case "event":
        this.events.push({ ...event, timestamp: event.timestamp ?? Date.now() });
        if (this.events.length > this.maxEvents) {
          this.events.shift();
        }
        break;
    }
  }

  getMetrics(): Record<string, unknown> {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(
        Array.from(this.histograms.entries()).map(([k, v]) => [
          k,
          { ...v, avg: v.sum / v.count },
        ])
      ),
      recentEvents: this.events.slice(-100),
    };
  }

  /**
   * Clear all stored metrics.
   */
  clear(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.events = [];
  }

  private buildKey(name: string, tags?: MetricTags): string {
    if (!tags || Object.keys(tags).length === 0) return name;

    // Sort tags for consistent keys
    const tagStr = Object.entries(tags)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");

    return `${name}{${tagStr}}`;
  }
}

/**
 * CompositeSink - Fan-out to multiple sinks.
 * Use this to send metrics to multiple backends simultaneously.
 */
export class CompositeSink implements MetricsSink {
  constructor(private sinks: MetricsSink[]) {}

  record(event: MetricEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.record(event);
      } catch (error) {
        // Don't let one failing sink break others
        console.error(`[CompositeSink] Sink failed to record:`, error);
      }
    }
  }

  startSpan(name: string, parent?: Span): Span | undefined {
    // Use first sink that supports tracing
    for (const sink of this.sinks) {
      if (sink.startSpan) {
        const span = sink.startSpan(name, parent);
        if (span) return span;
      }
    }
    return undefined;
  }

  endSpan(span: Span, error?: Error): void {
    for (const sink of this.sinks) {
      if (sink.endSpan) {
        try {
          sink.endSpan(span, error);
        } catch (err) {
          console.error(`[CompositeSink] Sink failed to end span:`, err);
        }
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.flush?.();
        } catch (err) {
          console.error(`[CompositeSink] Sink failed to flush:`, err);
        }
      })
    );
  }

  async dispose(): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.dispose?.();
        } catch (err) {
          console.error(`[CompositeSink] Sink failed to dispose:`, err);
        }
      })
    );
  }

  getMetrics(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const sink of this.sinks) {
      if (sink.getMetrics) {
        const metrics = sink.getMetrics();
        Object.assign(result, metrics);
      }
    }
    return result;
  }

  /**
   * Add a sink to the composite.
   */
  add(sink: MetricsSink): void {
    this.sinks.push(sink);
  }

  /**
   * Remove a sink from the composite.
   */
  remove(sink: MetricsSink): boolean {
    const idx = this.sinks.indexOf(sink);
    if (idx !== -1) {
      this.sinks.splice(idx, 1);
      return true;
    }
    return false;
  }
}

// =============================================================================
// METRIC NAMES (CONVENTIONS)
// =============================================================================

/**
 * Standard metric names used by pi-server.
 * These follow Prometheus naming conventions:
 * - _total for counters
 * - _seconds, _bytes, _count for units
 * - lowercase with underscores
 */
export const MetricNames = {
  // Sessions
  SESSIONS_ACTIVE: "pi_server_sessions_active",
  SESSIONS_CREATED_TOTAL: "pi_server_sessions_created_total",
  SESSIONS_DELETED_TOTAL: "pi_server_sessions_deleted_total",
  SESSION_LIFETIME_SECONDS: "pi_server_session_lifetime_seconds",

  // Commands
  COMMANDS_TOTAL: "pi_server_commands_total",
  COMMANDS_DURATION_MS: "pi_server_commands_duration_ms",
  COMMANDS_REJECTED_TOTAL: "pi_server_commands_rejected_total",
  COMMANDS_IN_FLIGHT: "pi_server_commands_in_flight",

  // Connections
  CONNECTIONS_ACTIVE: "pi_server_connections_active",
  CONNECTIONS_TOTAL: "pi_server_connections_total",

  // Circuit breakers
  CIRCUIT_BREAKER_STATE: "pi_server_circuit_breaker_state",
  CIRCUIT_BREAKER_TRANSITIONS_TOTAL: "pi_server_circuit_breaker_transitions_total",
  CIRCUIT_BREAKER_REJECTED_TOTAL: "pi_server_circuit_breaker_rejected_total",

  // Rate limiting
  RATE_LIMIT_REJECTED_TOTAL: "pi_server_rate_limit_rejected_total",
  RATE_LIMIT_GENERATION_COUNTER: "pi_server_rate_limit_generation_counter",

  // Extension UI
  EXTENSION_UI_PENDING: "pi_server_extension_ui_pending",
  EXTENSION_UI_TIMEOUTS_TOTAL: "pi_server_extension_ui_timeouts_total",

  // Memory
  STORE_SIZE: "pi_server_store_size",
  STORE_EVCTIONS_TOTAL: "pi_server_store_evictions_total",

  // Events (for event-type metrics)
  EVENT_SESSION_CREATED: "pi_server_event_session_created",
  EVENT_SESSION_DELETED: "pi_server_event_session_deleted",
  EVENT_CIRCUIT_OPENED: "pi_server_event_circuit_opened",
  EVENT_CIRCUIT_CLOSED: "pi_server_event_circuit_closed",
  EVENT_METADATA_RESET: "pi_server_event_metadata_reset",
} as const;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create standard tags for a command.
 */
export function commandTags(
  commandType: string,
  sessionId?: string,
  success?: boolean
): MetricTags {
  return {
    command: commandType,
    session_id: sessionId,
    success,
  };
}

/**
 * Create standard tags for a provider.
 */
export function providerTags(provider: string): MetricTags {
  return { provider };
}

/**
 * Create standard tags for a store.
 */
export function storeTags(storeName: string): MetricTags {
  return { store: storeName };
}
