/**
 * @fileoverview Importing the config and logger modules (as `ibmi --version`
 * and library consumers do) must not create the logs directory or start pino
 * transport worker threads.
 * @module tests/utils/internal/loggerImportSideEffects.test
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// tests/setup.ts replaces the logger with a no-op; this test needs the real one.
vi.unmock("../../../src/utils/internal/logger.js");

// Records whether a pino instance or transport is constructed.
const { pino, transport } = vi.hoisted(() => {
  const transport = vi.fn(() => ({ end: vi.fn() }));
  const pino = Object.assign(
    vi.fn(() => ({ info: vi.fn() })),
    {
      transport,
      stdTimeFunctions: { isoTime: () => "" },
      stdSerializers: { err: (err: unknown) => err },
    },
  );
  return { pino, transport };
});
vi.mock("pino", () => ({ default: pino }));

describe("importing config and logger", () => {
  const originalEnv = { ...process.env };
  const scratch = mkdtempSync(join(tmpdir(), "ibmi-mcp-lazy-logger-"));

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(scratch, { recursive: true, force: true });
    vi.resetModules();
  });

  it("should create no logs directory and no pino transport until the first log call", async () => {
    const logsDir = join(scratch, "logs");
    process.env.LOGS_DIR = logsDir;
    vi.resetModules();

    const { config } = await import("../../../src/config/index.js");
    const { logger } = await import("../../../src/utils/internal/logger.js");
    // The surface @ibm/ibmi-cli imports at startup.
    await import("../../../src/public/formatting.js");
    await import("../../../src/public/context.js");
    await import("../../../src/public/services.js");
    await import("../../../src/public/tools.js");

    expect(config.logsPath).toBe(logsDir);
    expect(existsSync(logsDir)).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    expect(pino).not.toHaveBeenCalled();

    logger.info("first record");

    expect(existsSync(logsDir)).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
    expect(pino).toHaveBeenCalledOnce();
  });
});
