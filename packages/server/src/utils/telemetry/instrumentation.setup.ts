/**
 * @fileoverview OpenTelemetry SDK initialization (heavy imports).
 * Loaded only via dynamic import from `instrumentation.ts` when
 * `OTEL_ENABLED=true`, so the default startup path never resolves these modules.
 * @module src/utils/telemetry/instrumentation.setup
 */
import { config } from "@/config/index.js";
import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  ReadableSpan,
  SpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions/incubating";

/** Started SDK instance; assigned by the facade after this module loads. */
export let startedSdk: NodeSDK | null = null;

// --- Custom Diagnostic Logger for OpenTelemetry ---
// This logger uses the standard console to avoid circular dependencies with the main application logger.
class OtelDiagnosticLogger extends DiagConsoleLogger {}

/**
 * A custom SpanProcessor that writes ended spans to a log file using Pino.
 */
class FileSpanProcessor implements SpanProcessor {
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  onStart(_span: ReadableSpan): void {}
  onEnd(span: ReadableSpan): void {
    const loggableSpan = {
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      name: span.name,
      kind: span.kind,
      startTime: span.startTime,
      endTime: span.endTime,
      duration: span.duration,
      status: span.status,
      attributes: span.attributes,
      events: span.events,
    };
    // Dynamically import the logger in a non-blocking way to prevent circular dependencies.
    import("@/utils/internal/logger.js")
      .then(({ logger }) => {
        logger.info({ span: loggableSpan }, "Trace Span End");
      })
      .catch((err) => {
        diag.error("Failed to dynamically import logger for OTel span.", err);
      });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

if (config.openTelemetry.enabled) {
  try {
    const otelLogLevel =
      DiagLogLevel[
        config.openTelemetry.logLevel as keyof typeof DiagLogLevel
      ] ?? DiagLogLevel.INFO;
    diag.setLogger(new OtelDiagnosticLogger(), otelLogLevel);

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.openTelemetry.serviceName,
      [ATTR_SERVICE_VERSION]: config.openTelemetry.serviceVersion,
      "deployment.environment.name": config.environment,
    });

    let spanProcessor: SpanProcessor;
    if (config.openTelemetry.tracesEndpoint) {
      diag.info(
        `Using OTLP exporter for traces, endpoint: ${config.openTelemetry.tracesEndpoint}`,
      );
      const traceExporter = new OTLPTraceExporter({
        url: config.openTelemetry.tracesEndpoint,
      });
      spanProcessor = new BatchSpanProcessor(traceExporter);
    } else {
      diag.info(
        "No OTLP endpoint configured. Using FileSpanProcessor for local trace logging.",
      );
      spanProcessor = new FileSpanProcessor();
    }

    const metricReader = config.openTelemetry.metricsEndpoint
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: config.openTelemetry.metricsEndpoint,
          }),
          exportIntervalMillis: 15000,
        })
      : undefined;

    startedSdk = new NodeSDK({
      resource,
      spanProcessors: [spanProcessor],
      metricReader,
      sampler: new TraceIdRatioBasedSampler(config.openTelemetry.samplingRatio),
      // Explicit instrumentations only: the auto-instrumentations-node
      // meta-package pulls in ~40 instrumentations and, transitively,
      // `systeminformation`, whose `os` allowlist excludes IBM i (os400)
      // and makes `npm install` fail there (GitHub discussion #175).
      instrumentations: [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (req) => req.url === "/healthz",
        }),
        // Injects trace_id/span_id into pino log records.
        new PinoInstrumentation(),
        // Spans for native `fetch` (see utils/network/fetchWithTimeout.ts).
        new UndiciInstrumentation(),
      ],
    });

    startedSdk.start();
    diag.info(
      `OpenTelemetry initialized for ${config.openTelemetry.serviceName} v${config.openTelemetry.serviceVersion}`,
    );
  } catch (error) {
    diag.error("Error initializing OpenTelemetry", error);
    process.exit(1);
  }
}
