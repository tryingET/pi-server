/**
 * ThresholdAlertSink - Triggers alerts when metrics cross thresholds.
 *
 * This is a pass-through sink that monitors metric values and triggers
 * alerts when thresholds are crossed. It wraps another sink (the actual
 * storage/transport) and just adds alerting capability.
 *
 * Design principles:
 * - Alerting is just another MetricsSink (pluggable like AuthProvider)
 * - Users bring their own alert handler (console, Slack, PagerDuty, etc.)
 * - Thresholds are configured per metric name
 * - Stateful: tracks if alert is already firing (prevents spam)
 *
 * @example
 * ```typescript
 * const alertSink = new ThresholdAlertSink({
 *   sink: new MemorySink(), // Pass-through to actual storage
 *   thresholds: {
 *     'pi_server_generation_counter': { warn: 1e12, critical: 1e15 },
 *     'pi_server_circuit_breaker_state': { warn: 1 }, // 1 = open
 *   },
 *   onAlert: async (alert) => {
 *     // Send to Slack, PagerDuty, etc.
 *     await fetch('https://hooks.slack.com/...', {
 *       method: 'POST',
 *       body: JSON.stringify({ text: `[${alert.level}] ${alert.message}` }),
 *     });
 *   },
 * });
 *
 * const metrics = new MetricsEmitter({ sink: alertSink });
 * ```
 */

import type { MetricEvent, MetricsSink } from "./metrics-types.js";

export type AlertLevel = "info" | "warn" | "critical";

export interface Alert {
  /** Metric name that triggered the alert */
  metricName: string;
  /** Current value */
  value: number;
  /** Threshold that was crossed */
  threshold: number;
  /** Alert level (info/warn/critical) */
  level: AlertLevel;
  /** Human-readable message */
  message: string;
  /** Tags from the metric event */
  tags?: Record<string, unknown>;
  /** Timestamp */
  timestamp: number;
}

export interface ThresholdConfig {
  /** Info threshold (optional) */
  info?: number;
  /** Warning threshold */
  warn: number;
  /** Critical threshold (optional) */
  critical?: number;
  /** How often to re-alert while above threshold (ms, default: 5 min) */
  realertAfterMs?: number;
}

export interface ThresholdAlertSinkConfig {
  /** The underlying sink to pass metrics through to */
  sink: MetricsSink;
  /** Thresholds per metric name */
  thresholds: Record<string, ThresholdConfig>;
  /** Called when an alert fires */
  onAlert: (alert: Alert) => void | Promise<void>;
  /** Called when alert clears (optional) */
  onClear?: (alert: Alert) => void | Promise<void>;
  /** Maximum number of alert states to track (default: 1000, prevents OOM from high-cardinality tags) */
  maxAlertStates?: number;
}

interface AlertState {
  level: AlertLevel | null;
  lastAlertTime: number;
  value: number;
}

/**
 * ThresholdAlertSink - Monitors metrics and fires alerts on threshold crossing.
 */
export class ThresholdAlertSink implements MetricsSink {
  private sink: MetricsSink;
  private thresholds: Record<string, ThresholdConfig>;
  private onAlert: (alert: Alert) => void | Promise<void>;
  private onClear?: (alert: Alert) => void | Promise<void>;
  private alertStates = new Map<string, AlertState>();
  private maxAlertStates: number;

  constructor(config: ThresholdAlertSinkConfig) {
    this.sink = config.sink;
    this.thresholds = config.thresholds;
    this.onAlert = config.onAlert;
    this.onClear = config.onClear;
    this.maxAlertStates = config.maxAlertStates ?? 1000;

    // Validate threshold configs
    for (const [name, cfg] of Object.entries(config.thresholds)) {
      if (cfg.warn < 0) {
        throw new Error(`Threshold config for "${name}" has negative warn threshold: ${cfg.warn}`);
      }
      if (cfg.critical !== undefined && cfg.critical < cfg.warn) {
        throw new Error(
          `Threshold config for "${name}" has critical (${cfg.critical}) < warn (${cfg.warn})`
        );
      }
      if (cfg.info !== undefined && cfg.info > cfg.warn) {
        throw new Error(
          `Threshold config for "${name}" has info (${cfg.info}) > warn (${cfg.warn})`
        );
      }
    }
  }

  record(event: MetricEvent): void {
    // Pass through to underlying sink first
    this.sink.record(event);

    // Check thresholds if this metric is being watched
    const config = this.thresholds[event.name];
    if (!config) {
      return;
    }

    // Only process numeric values (MetricValue can be string/boolean)
    const value = event.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return;
    }

    this.checkThreshold(event, value, config);
  }

  private checkThreshold(event: MetricEvent, value: number, config: ThresholdConfig): void {
    const key = this.buildStateKey(event);
    const state = this.alertStates.get(key);
    const now = Date.now();

    // Determine current level
    let newLevel: AlertLevel | null = null;
    if (config.critical !== undefined && value >= config.critical) {
      newLevel = "critical";
    } else if (value >= config.warn) {
      newLevel = "warn";
    } else if (config.info !== undefined && value >= config.info) {
      newLevel = "info";
    }

    const previousLevel = state?.level ?? null;
    const realertAfterMs = config.realertAfterMs ?? 5 * 60 * 1000;

    // Should we fire an alert?
    const levelChanged = newLevel !== previousLevel;
    const shouldRealert =
      newLevel !== null && state !== undefined && now - state.lastAlertTime >= realertAfterMs;

    if (levelChanged || shouldRealert) {
      if (newLevel !== null) {
        // Fire alert
        const alert: Alert = {
          metricName: event.name,
          value,
          threshold: this.getThresholdForLevel(config, newLevel),
          level: newLevel,
          message: `${event.name} = ${value} (threshold: ${this.getThresholdForLevel(config, newLevel)})`,
          tags: event.tags,
          timestamp: now,
        };

        // Fire asynchronously, don't block metrics recording
        Promise.resolve()
          .then(() => this.onAlert(alert))
          .catch((err) => {
            console.error("[ThresholdAlertSink] Alert handler failed:", err);
          });

        this.setAlertState(key, {
          level: newLevel,
          lastAlertTime: now,
          value,
        });
      } else if (previousLevel !== null && this.onClear) {
        // Alert cleared
        const alert: Alert = {
          metricName: event.name,
          value,
          threshold: this.getThresholdForLevel(config, previousLevel),
          level: previousLevel,
          message: `${event.name} cleared: ${value} (was above ${this.getThresholdForLevel(config, previousLevel)})`,
          tags: event.tags,
          timestamp: now,
        };

        Promise.resolve()
          .then(() => this.onClear!(alert))
          .catch((err) => {
            console.error("[ThresholdAlertSink] Clear handler failed:", err);
          });

        this.setAlertState(key, {
          level: null,
          lastAlertTime: now,
          value,
        });
      }
    } else if (state) {
      // Update value but keep state
      state.value = value;
    }
  }

  /**
   * Set alert state with LRU eviction to prevent unbounded growth.
   */
  private setAlertState(key: string, state: AlertState): void {
    if (this.alertStates.size >= this.maxAlertStates && !this.alertStates.has(key)) {
      // Evict oldest entry (first key in Map iteration order)
      const oldestKey = this.alertStates.keys().next().value;
      if (oldestKey !== undefined) {
        this.alertStates.delete(oldestKey);
      }
    }
    this.alertStates.set(key, state);
  }

  private getThresholdForLevel(config: ThresholdConfig, level: AlertLevel): number {
    switch (level) {
      case "critical":
        return config.critical ?? config.warn;
      case "warn":
        return config.warn;
      case "info":
        return config.info ?? config.warn;
    }
  }

  private buildStateKey(event: MetricEvent): string {
    if (!event.tags || Object.keys(event.tags).length === 0) {
      return event.name;
    }
    const tagStr = Object.entries(event.tags)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return `${event.name}{${tagStr}}`;
  }

  // Pass-through methods for underlying sink

  startSpan(
    name: string,
    parent?: import("./metrics-types.js").Span
  ): import("./metrics-types.js").Span | undefined {
    return this.sink.startSpan?.(name, parent);
  }

  endSpan(span: import("./metrics-types.js").Span, error?: Error): void {
    this.sink.endSpan?.(span, error);
  }

  async flush(): Promise<void> {
    await this.sink.flush?.();
  }

  async dispose(): Promise<void> {
    await this.sink.dispose?.();
  }

  getMetrics?(): Record<string, unknown> {
    return this.sink.getMetrics?.() ?? {};
  }

  /**
   * Get current alert states (for debugging/monitoring).
   */
  getAlertStates(): Map<string, AlertState> {
    return new Map(this.alertStates);
  }

  /**
   * Add or update a threshold at runtime.
   */
  setThreshold(metricName: string, config: ThresholdConfig): void {
    this.thresholds[metricName] = config;
  }

  /**
   * Remove a threshold.
   */
  removeThreshold(metricName: string): void {
    delete this.thresholds[metricName];
    // Also clear any alert state
    for (const key of this.alertStates.keys()) {
      if (key === metricName || key.startsWith(metricName + "{")) {
        this.alertStates.delete(key);
      }
    }
  }
}

// =============================================================================
// BUILT-IN ALERT HANDLERS
// =============================================================================

/**
 * Console alert handler - logs alerts to console.
 * Useful for development and testing.
 */
export function consoleAlertHandler(alert: Alert): void {
  const levelStr = alert.level.toUpperCase().padEnd(8);
  const log = alert.level === "critical" ? console.error : console.log;
  log(`[${levelStr}] ${alert.message}`);
  if (alert.tags && Object.keys(alert.tags).length > 0) {
    log(`           Tags: ${JSON.stringify(alert.tags)}`);
  }
}

/**
 * Create a Slack alert handler.
 * Posts to a Slack webhook when alerts fire.
 */
export function createSlackAlertHandler(webhookUrl: string): (alert: Alert) => Promise<void> {
  return async (alert: Alert) => {
    const color =
      alert.level === "critical" ? "danger" : alert.level === "warn" ? "warning" : "#439FE0";
    const emoji = alert.level === "critical" ? "🚨" : alert.level === "warn" ? "⚠️" : "ℹ️";

    const payload = {
      attachments: [
        {
          color,
          title: `${emoji} ${alert.level.toUpperCase()}: ${alert.metricName}`,
          text: alert.message,
          fields: alert.tags
            ? Object.entries(alert.tags)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => ({ title: k, value: String(v), short: true }))
            : [],
          ts: Math.floor(alert.timestamp / 1000),
        },
      ],
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status} ${await response.text()}`);
    }
  };
}
