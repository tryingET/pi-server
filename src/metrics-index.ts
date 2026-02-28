/**
 * Metrics System - Public API
 *
 * Re-exports all metrics types and utilities for convenience.
 * Import from this file to use the metrics system.
 *
 * @example
 * ```typescript
 * import {
 *   MetricsEmitter,
 *   MemorySink,
 *   CompositeSink,
 *   MetricNames,
 * } from "./metrics-index.js";
 *
 * const metrics = new MetricsEmitter({
 *   sink: new CompositeSink([
 *     new MemorySink(),  // For get_metrics command
 *   ]),
 * });
 * ```
 */

// Core types
export type {
  MetricValue,
  MetricTags,
  MetricType,
  MetricEvent,
  Span,
  MetricsSink,
} from "./metrics-types.js";

// Built-in sinks
export {
  NoOpSink,
  ConsoleSink,
  MemorySink,
  CompositeSink,
} from "./metrics-types.js";

// Alerting
export {
  ThresholdAlertSink,
  consoleAlertHandler,
  createSlackAlertHandler,
} from "./threshold-alert-sink.js";
export type {
  Alert,
  AlertLevel,
  ThresholdConfig,
  ThresholdAlertSinkConfig,
} from "./threshold-alert-sink.js";

// Emitter
export {
  MetricsEmitter,
  getGlobalMetrics,
  setGlobalMetrics,
  requireGlobalMetrics,
} from "./metrics-emitter.js";

// TimerHandle is a type-only export
export type { TimerHandle } from "./metrics-emitter.js";

// Standard metric names
export { MetricNames } from "./metrics-types.js";

// Helper functions
export {
  commandTags,
  providerTags,
  storeTags,
} from "./metrics-types.js";
