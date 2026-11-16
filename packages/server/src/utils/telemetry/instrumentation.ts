/**
 * @fileoverview OpenTelemetry lifecycle facade.
 * Heavy SDK modules live in `instrumentation.setup.ts` and are loaded only when
 * `OTEL_ENABLED=true`, so the default startup path never resolves them.
 * @module src/utils/telemetry/instrumentation
 */
import { config } from "@/config/index.js";

/** Minimal SDK surface used for graceful shutdown. */
export type OpenTelemetrySdk = {
  shutdown(): Promise<void>;
};

export let sdk: OpenTelemetrySdk | null = null;

/**
 * Why OpenTelemetry could not start although `OTEL_ENABLED=true`. The entry
 * point fails startup on it; this module never exits the process.
 */
export let openTelemetryStartupError: unknown;

if (config.openTelemetry.enabled) {
  try {
    const { startedSdk } = await import("./instrumentation.setup.js");
    sdk = startedSdk;
  } catch (error) {
    openTelemetryStartupError = error;
  }
}

/**
 * Gracefully shuts down the OpenTelemetry SDK when it was initialized.
 */
export async function shutdownOpenTelemetry(): Promise<void> {
  if (!sdk) {
    return;
  }
  try {
    await sdk.shutdown();
    const { diag } = await import("@opentelemetry/api");
    diag.info("OpenTelemetry terminated");
  } catch (error) {
    const { diag } = await import("@opentelemetry/api");
    diag.error("Error terminating OpenTelemetry", error);
  }
}
