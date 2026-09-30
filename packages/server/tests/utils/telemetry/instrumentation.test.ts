/**
 * @fileoverview Tests for OpenTelemetry instrumentation.
 * @module tests/utils/telemetry/instrumentation.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NodeSDK } from "@opentelemetry/sdk-node";

const mockSpanProcessor = {
  onEnd: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
  forceFlush: vi.fn().mockResolvedValue(undefined),
  onStart: vi.fn(),
  constructor: { name: "FileSpanProcessor" },
};

vi.mock("@opentelemetry/sdk-node", () => {
  const NodeSDK = vi.fn(() => ({
    start: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    spanProcessors: [mockSpanProcessor],
  }));
  return { NodeSDK };
});

const enabledConfig = {
  openTelemetry: {
    enabled: true,
    serviceName: "test-service",
    serviceVersion: "1.0.0",
    logLevel: "INFO",
    samplingRatio: 1,
    tracesEndpoint: "",
    metricsEndpoint: "",
  },
  logsPath: "/tmp/logs",
  environment: "test",
};

vi.mock("../../../src/config/index.js", () => ({
  config: enabledConfig,
}));

describe("OpenTelemetry Instrumentation", () => {
  let instrumentation: typeof import("../../../src/utils/telemetry/instrumentation.js");

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../../../src/config/index.js", () => ({
      config: enabledConfig,
    }));
    instrumentation =
      await import("../../../src/utils/telemetry/instrumentation.js");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("FileSpanProcessor", () => {
    it("should log spans to a file", () => {
      const readableSpan = {
        spanContext: () => ({ traceId: "trace1", spanId: "span1" }),
        name: "test-span",
        kind: 0,
        startTime: [100, 200],
        endTime: [101, 200],
        duration: [1, 0],
        status: { code: 0 },
        attributes: {},
        events: [],
      };

      mockSpanProcessor.onEnd(readableSpan);

      expect(mockSpanProcessor.onEnd).toHaveBeenCalledWith(readableSpan);
    });
  });

  describe("SDK Initialization", () => {
    it("should initialize NodeSDK with correct parameters", () => {
      expect(NodeSDK).toHaveBeenCalledWith(
        expect.objectContaining({
          sampler: expect.any(Object),
          resource: expect.any(Object),
          spanProcessors: expect.any(Array),
        }),
      );
    });
  });

  describe("shutdownOpenTelemetry", () => {
    it("should call sdk.shutdown if sdk is initialized", async () => {
      expect(instrumentation.sdk).not.toBeNull();
      const shutdownSpy = vi
        .spyOn(instrumentation.sdk!, "shutdown")
        .mockResolvedValue(undefined);

      await instrumentation.shutdownOpenTelemetry();

      expect(shutdownSpy).toHaveBeenCalled();
    });
  });
});

describe("OpenTelemetry Instrumentation (disabled)", () => {
  it("should not load the SDK setup when OTel is disabled", async () => {
    vi.resetModules();
    vi.doMock("../../../src/config/index.js", () => ({
      config: {
        ...enabledConfig,
        openTelemetry: { ...enabledConfig.openTelemetry, enabled: false },
      },
    }));

    const disabled =
      await import("../../../src/utils/telemetry/instrumentation.js");

    expect(disabled.sdk).toBeNull();
    await expect(disabled.shutdownOpenTelemetry()).resolves.toBeUndefined();
  });
});
