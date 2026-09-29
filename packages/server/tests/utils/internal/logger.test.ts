/**
 * @fileoverview Tests how the logger picks its transport targets, covering the
 * MCP_LOG_TO_FILE escape hatch for environments that collect stderr themselves
 * and have no writable log directory (e.g. ECS with awslogs).
 *
 * @module tests/utils/internal/logger.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tests/setup.ts stubs the logger module globally to silence output; these tests
// exercise the real module.
vi.unmock("../../../src/utils/internal/logger.js");

interface CapturedTarget {
  target: string;
  options?: { destination?: number | string; file?: string };
}

interface CapturedOptions {
  transport?: { targets?: CapturedTarget[] };
}

const capturedOptions: CapturedOptions[] = [];

/** Config fields the logger reads, with the failure case as the default. */
function mockConfig(overrides: Record<string, unknown> = {}) {
  vi.doMock("../../../src/config/index.js", () => ({
    config: {
      mcpServerName: "test-server",
      logLevel: "info",
      environment: "production",
      mcpTransportType: "http",
      logsPath: null,
      logToFile: true,
      ...overrides,
    },
  }));
}

function mockPino() {
  vi.doMock("pino", () => {
    const instance: Record<string, unknown> = {
      level: "info",
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    };
    instance.child = () => instance;

    const pino = vi.fn((options: CapturedOptions) => {
      capturedOptions.push(options);
      return instance;
    });
    Object.assign(pino, {
      stdTimeFunctions: { isoTime: () => "1970-01-01T00:00:00.000Z" },
      stdSerializers: { err: (err: Error) => err },
    });

    return { default: pino };
  });
}

/** Targets of the main logger, which is the first instance created. */
function mainLoggerTargets(): CapturedTarget[] {
  return capturedOptions[0]?.transport?.targets ?? [];
}

async function importLogger() {
  return import("../../../src/utils/internal/logger.js");
}

beforeEach(() => {
  capturedOptions.length = 0;
  vi.resetModules();
  mockPino();
});

afterEach(() => {
  vi.doUnmock("../../../src/config/index.js");
  vi.doUnmock("pino");
});

describe("logger transport targets", () => {
  it("fails fast in production when file logging is required but unavailable", async () => {
    mockConfig({ logToFile: true, logsPath: null });

    await expect(importLogger()).rejects.toThrow(/MCP_LOG_TO_FILE=false/);
  });

  it("logs to stderr only when file logging is turned off", async () => {
    mockConfig({ logToFile: false, logsPath: null });

    await expect(importLogger()).resolves.toBeDefined();

    const targets = mainLoggerTargets();
    expect(targets.map((t) => t.target)).toEqual(["pino/file"]);
    expect(targets[0].options?.destination).toBe(process.stderr.fd);
  });

  it("keeps stderr as the sink for stdio transport when file logging is off", async () => {
    mockConfig({
      logToFile: false,
      logsPath: null,
      mcpTransportType: "stdio",
    });

    await expect(importLogger()).resolves.toBeDefined();

    // STDIO normally logs to files only; with no file target it would otherwise
    // log nowhere. Never stdout, which is reserved for JSON-RPC.
    const targets = mainLoggerTargets();
    expect(targets.map((t) => t.target)).toEqual(["pino/file"]);
    expect(targets[0].options?.destination).toBe(process.stderr.fd);
  });

  it("adds rotating file targets when a logs directory is available", async () => {
    mockConfig({ logToFile: true, logsPath: "/tmp/ibmi-mcp-test-logs" });

    await expect(importLogger()).resolves.toBeDefined();

    const targets = mainLoggerTargets();
    expect(targets.filter((t) => t.target === "pino-roll").length).toBe(5);
    expect(targets.map((t) => t.target)).toContain("pino/file");
  });
});
