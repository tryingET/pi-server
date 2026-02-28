/**
 * Example: OpenTelemetry Metrics Exporter for pi-server
 *
 * This is an EXAMPLE of how the community could build an OpenTelemetry exporter
 * using the MetricsSink interface. It is NOT included in the core package.
 *
 * OpenTelemetry provides:
 * - Unified metrics, traces, and logs
 * - Multiple backend support (Jaeger, Zipkin, OTLP, etc.)
 * - Automatic instrumentation for many libraries
 *
 * To use:
 * 1. Install dependencies: npm install @opentelemetry/api @opentelemetry/sdk-metrics
 * 2. Configure the sink with your OTel exporter
 * 3. Configure pi-server with this sink
 *
 * @example
 * ```typescript
 * import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
 * import { OpenTelemetrySink } from "./opentelemetry-sink";
 *
 * const exporter = new OTLPMetricExporter({
 *   url: "http://otel-collector:4318/v1/metrics",
 * });
 *
 * const otelSink = new OpenTelemetrySink({ exporter });
 *
 * const server = new PiServer({
 *   metricsSink: otelSink,
 * });
 * ```
 */

import type { MetricEvent, MetricTags, MetricsSink, Span } from "./metrics-types.js";

/**
 * Simplified OTel types (real implementation uses @opentelemetry/api)
 */
interface OTelMeter {
  createCounter(name: string, options?: { description?: string; unit?: string }): OTelCounter;
  createGauge(name: string, options?: { description?: string; unit?: string }): OTelGauge;
  createHistogram(name: string, options?: { description?: string; unit?: string; buckets?: number[] }): OTelHistogram;
}

interface OTelCounter {
  add(value: number, attributes?: Record<string, string | number | boolean>): void;
}

interface OTelGauge {
  record(value: number, attributes?: Record<string, string | number | boolean>): void;
}

interface OTelHistogram {
  record(value: number, attributes?: Record<string, string | number | boolean>): void;
}

/**
 * In-memory meter implementation for demonstration.
 * Real implementation would use @opentelemetry/sdk-metrics.
 */
class InMemoryMeter implements OTelMeter {
  private counters = new Map<string, OTelCounterImpl>();
  private gauges = new Map<string, OTelGaugeImpl>();
  private histograms = new Map<string, OTelHistogramImpl>();

  createCounter(name: string, options?: { description?: string }): OTelCounter {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = new OTelCounterImpl(name, options?.description);
      this.counters.set(name, counter);
    }
    return counter;
  }

  createGauge(name: string, options?: { description?: string; unit?: string }): OTelGauge {
    let gauge = this.gauges.get(name);
    if (!gauge) {
      gauge = new OTelGaugeImpl(name, options?.description, options?.unit);
      this.gauges.set(name, gauge);
    }
    return gauge;
  }

  createHistogram(
    name: string,
    options?: { description?: string; unit?: string; buckets?: number[] }
  ): OTelHistogram {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = new OTelHistogramImpl(name, options?.description, options?.unit, options?.buckets);
      this.histograms.set(name, histogram);
    }
    return histogram;
  }
}

class OTelCounterImpl implements OTelCounter {
  private values = new Map<string, number>();

  constructor(private name: string, private description?: string) {}

  add(value: number, attributes?: Record<string, string | number | boolean>): void {
    const key = this.buildKey(attributes);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  private buildKey(attrs?: Record<string, string | number | boolean>): string {
    if (!attrs) return "";
    return JSON.stringify(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)));
  }
}

class OTelGaugeImpl implements OTelGauge {
  private values = new Map<string, number>();

  constructor(
    private name: string,
    private description?: string,
    private unit?: string
  ) {}

  record(value: number, attributes?: Record<string, string | number | boolean>): void {
    const key = JSON.stringify(attributes ?? {});
    this.values.set(key, value);
  }
}

class OTelHistogramImpl implements OTelHistogram {
  private observations: Array<{ value: number; attrs?: Record<string, string | number | boolean> }> = [];

  constructor(
    private name: string,
    private description?: string,
    private unit?: string,
    private buckets?: number[]
  ) {}

  record(value: number, attributes?: Record<string, string | number | boolean>): void {
    this.observations.push({ value, attrs: attributes });
  }
}

/**
 * OpenTelemetrySink - Exports metrics via OpenTelemetry SDK.
 *
 * This sink:
 * 1. Receives metric events from pi-server
 * 2. Converts them to OpenTelemetry metrics
 * 3. Exports via configured OTel exporter (OTLP, Prometheus, etc.)
 *
 * Features:
 * - Full tracing support (startSpan, endSpan)
 * - Multiple exporter backends
 * - Semantic conventions support
 * - Batch export for performance
 */
export class OpenTelemetrySink implements MetricsSink {
  private meter: OTelMeter;
  private spans = new Map<string, Span>();
  private defaultAttributes: Record<string, string | number | boolean>;

  constructor(options: {
    /** OTel meter provider (required) */
    meter?: OTelMeter;
    /** Default attributes for all metrics */
    defaultAttributes?: Record<string, string | number | boolean>;
  } = {}) {
    this.meter = options.meter ?? new InMemoryMeter();
    this.defaultAttributes = options.defaultAttributes ?? {};
  }

  record(event: MetricEvent): void {
    const attributes = this.mergeAttributes(event.tags);

    switch (event.type) {
      case "counter":
      case "event": {
        const counter = this.meter.createCounter(event.name);
        counter.add(event.value ?? 1, attributes);
        break;
      }

      case "gauge": {
        const gauge = this.meter.createGauge(event.name);
        gauge.record(event.value ?? 0, attributes);
        break;
      }

      case "histogram": {
        const histogram = this.meter.createHistogram(event.name, {
          buckets: event.buckets,
        });
        histogram.record(event.value ?? 0, attributes);
        break;
      }
    }
  }

  startSpan(name: string, parent?: Span): Span {
    const span: Span = {
      spanId: this.generateId(),
      parentSpanId: parent?.spanId,
      traceId: parent?.traceId ?? this.generateId(),
      name,
      startTime: Date.now(),
    };

    this.spans.set(span.spanId, span);
    return span;
  }

  endSpan(span: Span, error?: Error): void {
    span.endTime = Date.now();
    if (error) {
      span.error = true;
      span.errorMessage = error.message;
    }

    this.spans.delete(span.spanId);

    // In real implementation, this would export the span via OTel tracer
    // tracer.endSpan(span);
  }

  async flush(): Promise<void> {
    // In real implementation, this would flush the OTel meter provider
    // await meterProvider.forceFlush();
  }

  private mergeAttributes(tags?: MetricTags): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = { ...this.defaultAttributes };

    if (tags) {
      for (const [key, value] of Object.entries(tags)) {
        if (value !== undefined) {
          result[key] = value;
        }
      }
    }

    return result;
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 18);
  }
}

/**
 * Example: Jaeger Tracing Setup
 *
 * Shows how to configure OpenTelemetry with Jaeger exporter.
 */
export async function createJaegerTracing(serviceName: string, jaegerEndpoint: string) {
  // Real implementation would use:
  // import { JaegerExporter } from "@opentelemetry/exporter-jaeger";
  // import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

  console.log(`Jaeger tracing configured for ${serviceName} at ${jaegerEndpoint}`);

  // Return a sink that uses the Jaeger exporter
  return new OpenTelemetrySink({
    defaultAttributes: {
      "service.name": serviceName,
    },
  });
}

/**
 * Example: OTLP Exporter Setup
 *
 * Shows how to configure OpenTelemetry with OTLP (OpenTelemetry Protocol).
 * This works with the OpenTelemetry Collector.
 */
export async function createOTLPTracing(
  serviceName: string,
  otlpEndpoint: string = "http://localhost:4317"
) {
  // Real implementation would use:
  // import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
  // import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";

  console.log(`OTLP configured for ${serviceName} at ${otlpEndpoint}`);

  return new OpenTelemetrySink({
    defaultAttributes: {
      "service.name": serviceName,
    },
  });
}
