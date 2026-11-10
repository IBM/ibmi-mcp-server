/**
 * @fileoverview Tests for the Pino logger wrapper.
 * @module tests/utils/internal/logger.test
 */

import { describe, it, expect, vi } from "vitest";

// tests/setup.ts replaces the logger with a no-op; these tests need the real one.
vi.unmock("../../../src/utils/internal/logger.js");

// Stand-in for pino so no transport worker threads or log files are created.
vi.mock("pino", () => {
  const pino = Object.assign(
    vi.fn((options: { level: string }) => ({
      level: options.level,
      fatal: vi.fn(),
    })),
    {
      stdTimeFunctions: { isoTime: () => "" },
      stdSerializers: { err: (err: unknown) => err },
    },
  );
  return { default: pino };
});

const testConfig = {
  environment: "test",
  mcpTransportType: "http",
  mcpServerName: "test-server",
  logsPath: null as string | null,
  logLevel: "debug",
};

vi.mock("../../../src/config/index.js", () => ({ config: testConfig }));

describe("logger", () => {
  const loadLogger = async (logLevel: string) => {
    testConfig.logLevel = logLevel;
    vi.resetModules();
    return import("../../../src/utils/internal/logger.js");
  };

  it.each([
    ["debug", "debug"],
    ["notice", "info"],
    ["warning", "warn"],
    ["warn", "warn"],
    ["emerg", "fatal"],
    ["not-a-level", "info"],
  ])("should map MCP_LOG_LEVEL=%s to pino level %s", async (mcp, pino) => {
    const { logger } = await loadLogger(mcp);

    expect(logger.pino.level).toBe(pino);
  });

  it("should expose the current instance after reinitializeLogger()", async () => {
    const { logger, reinitializeLogger } = await loadLogger("info");
    const first = logger.pino;

    testConfig.logLevel = "error";
    reinitializeLogger();

    expect(logger.pino).not.toBe(first);
    expect(logger.pino.level).toBe("error");
  });

  it("should not register process-level handlers: the entry point owns process exit", async () => {
    const before = process.listeners("uncaughtException").length;

    const { reinitializeLogger } = await loadLogger("info");
    reinitializeLogger();

    expect(process.listeners("uncaughtException")).toHaveLength(before);
  });

  it("should resolve flushLogger() once pino has flushed", async () => {
    const { logger, flushLogger } = await loadLogger("info");
    const flush = vi.fn((done: () => void) => done());
    Object.assign(logger.pino, { flush });

    await flushLogger();

    expect(flush).toHaveBeenCalledOnce();
  });
});
