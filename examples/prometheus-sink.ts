/**
 * Example: Prometheus Metrics Exporter for pi-server
 *
 * This is an EXAMPLE of how the community could build a Prometheus exporter
 * using the MetricsSink interface. It is NOT included in the core package.
 *
 * To use:
 * 1. Copy this file to your project
 * 2. Install prom-client: npm install prom-client
 * 3. Configure pi-server with this sink
 * 4. Expose /metrics endpoint in your HTTP server
 *
 * @example
 * ```typescript
 * import { PrometheusSink } from "./prometheus-sink";
 * import { PiServer } from "pi-app-server";
 *
 * const promSink = new PrometheusSink();
 *
 * const server = new PiServer({
 *   metricsSink: promSink,
 * });
 *
 * // In your HTTP server:
 * app.get("/metrics", async (req, res) => {
 *   res.set("Content-Type", promSink.getContentType());
 *   res.send(await promSink.metrics());
 * });
 * ```
 */

import type { MetricEvent, MetricTags, MetricsSink, Span } from "./metrics-types.js";

/**
 * Prometheus metric types.
 * These map to prom-client's metric types.
 */
interface PrometheusMetric {
  observe(value: number, tags?: Record<string, string>): void;
  inc(value?: number, tags?: Record<string, string>): void;
  dec(value?: number, tags?: Record<string, string>): void;
  set(value: number, tags?: Record<string, string>): void;
}

/**
 * In-memory storage for metrics when prom-client is not available.
 * This is a simplified implementation for demonstration.
 */
class SimpleMetric {
  private values = new Map<string, number>();

  constructor(
    private type: "counter" | "gauge" | "histogram",
    private name: string,
    private help: string,
    private labelNames: string[] = []
  ) {}

  private buildLabelString(tags?: Record<string, string>): string {
    if (!tags || this.labelNames.length === 0) return "";

    const parts = this.labelNames
      .filter((name) => tags[name] !== undefined)
      .map((name) => `${name}="${tags[name]}"`);

    return parts.length > 0 ? `{${parts.join(",")}}` : "";
  }

  inc(value = 1, tags?: Record<string, string>): void {
    const key = this.buildLabelString(tags);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  dec(value = 1, tags?: Record<string, string>): void {
    const key = this.buildLabelString(tags);
    this.values.set(key, (this.values.get(key) ?? 0) - value);
  }

  set(value: number, tags?: Record<string, string>): void {
    const key = this.buildLabelString(tags);
    this.values.set(key, value);
  }

  observe(value: number, tags?: Record<string, string>): void {
    // For histograms, we'd need bucket tracking
    // This is simplified - real implementation uses prom-client
    const key = this.buildLabelString(tags);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  export(): string {
    const lines: string[] = [];

    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} ${this.type}`);

    for (const [labels, value] of this.values) {
      lines.push(`${this.name}${labels} ${value}`);
    }

    return lines.join("\n");
  }
}

/**
 * PrometheusSink - Exports metrics in Prometheus text format.
 *
 * This sink:
 * 1. Receives metric events from pi-server
 * 2. Converts them to Prometheus format
 * 3. Exposes them via the /metrics endpoint (you provide the HTTP server)
 *
 * Features:
 * - Automatic metric type detection
 * - Label support from tags
 * - Histogram bucket configuration
 * - OpenMetrics format support
 */
export class PrometheusSink implements MetricsSink {
  private metrics = new Map<string, SimpleMetric>();
  private defaultBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  private labelAllowlist: Set<string> | null = null;

  constructor(options: {
    /** Default histogram buckets */
    buckets?: number[];
    /** Only allow these label names (null = allow all) */
    allowedLabels?: string[];
  } = {}) {
    if (options.buckets) {
      this.defaultBuckets = options.buckets;
    }
    if (options.allowedLabels) {
      this.labelAllowlist = new Set(options.allowedLabels);
    }
  }

  record(event: MetricEvent): void {
    const metric = this.getOrCreateMetric(event);
    if (!metric) return;

    const labels = this.tagsToLabels(event.tags);
    const value = event.value ?? 1;

    switch (event.type) {
      case "counter":
        metric.inc(value, labels);
        break;
      case "gauge":
        metric.set(value, labels);
        break;
      case "histogram":
        metric.observe(value, labels);
        break;
      case "event":
        // Events are counters
        metric.inc(1, labels);
        break;
    }
  }

  /**
   * Export metrics in Prometheus text format.
   * Call this from your /metrics endpoint handler.
   */
  async metrics(): Promise<string> {
    const lines: string[] = [];

    // Export all metrics
    for (const metric of this.metrics.values()) {
      lines.push(metric.export());
    }

    return lines.join("\n") + "\n";
  }

  /**
   * Get the Content-Type header value for Prometheus responses.
   */
  getContentType(): string {
    return "text/plain; version=0.0.4; charset=utf-8";
  }

  /**
   * Get OpenMetrics Content-Type (for newer Prometheus versions).
   */
  getOpenMetricsContentType(): string {
    return "application/openmetrics-text; version=1.0.0; charset=utf-8";
  }

  /**
   * Clear all metrics.
   */
  clear(): void {
    this.metrics.clear();
  }

  private getOrCreateMetric(event: MetricEvent): SimpleMetric | null {
    const existing = this.metrics.get(event.name);
    if (existing) return existing;

    // Infer label names from tags
    const labelNames = event.tags ? Object.keys(event.tags) : [];

    // Filter by allowlist if configured
    const filteredLabels = this.labelAllowlist
      ? labelNames.filter((name) => this.labelAllowlist!.has(name))
      : labelNames;

    // Determine Prometheus type
    let promType: "counter" | "gauge" | "histogram";
    switch (event.type) {
      case "counter":
      case "event":
        promType = "counter";
        break;
      case "gauge":
        promType = "gauge";
        break;
      case "histogram":
        promType = "histogram";
        break;
    }

    const metric = new SimpleMetric(
      promType,
      event.name,
      `Metric ${event.name}`,
      filteredLabels
    );

    this.metrics.set(event.name, metric);
    return metric;
  }

  private tagsToLabels(tags?: MetricTags): Record<string, string> {
    if (!tags) return {};

    const labels: Record<string, string> = {};

    for (const [key, value] of Object.entries(tags)) {
      if (value === undefined) continue;

      // Filter by allowlist
      if (this.labelAllowlist && !this.labelAllowlist.has(key)) {
        continue;
      }

      // Sanitize key (Prometheus label requirements)
      const sanitizedKey = key.replace(/[^a-zA-Z0-9_]/g, "_");

      // Convert value to string
      labels[sanitizedKey] = String(value);
    }

    return labels;
  }
}

/**
 * Example HTTP server setup with Prometheus metrics endpoint.
 *
 * This is NOT part of pi-server - it's an example of how you would
 * set up metrics in your own deployment.
 */
export async function createMetricsServer(promSink: PrometheusSink, port = 9090) {
  // This would use Node's http module or Express/Fastify/etc.
  // Example with raw http:

  const http = await import("http");

  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      try {
        const metrics = await promSink.metrics();
        res.writeHead(200, { "Content-Type": promSink.getContentType() });
        res.end(metrics);
      } catch (error) {
        res.writeHead(500);
        res.end(`Error: ${error}`);
      }
    } else {
      res.writeHead(404);
      res.end("Not found. Use /metrics endpoint.");
    }
  });

  return new Promise<void>((resolve) => {
    server.listen(port, () => {
      console.log(`Prometheus metrics available at http://localhost:${port}/metrics`);
      resolve();
    });
  });
}
