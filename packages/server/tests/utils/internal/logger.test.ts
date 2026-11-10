/**
 * @fileoverview Tests for the Pino logger wrapper.
 * @module tests/utils/internal/logger.test
 */

import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// tests/setup.ts replaces the logger with a no-op; these tests need the real one.
vi.unmock("../../../src/utils/internal/logger.js");

// Stand-in for pino so no transport worker threads or log files are created.
const { pino, transport } = vi.hoisted(() => {
  const transport = vi.fn((_options: { targets: unknown[] }) => ({
    end: vi.fn(),
  }));
  const pino = Object.assign(
    vi.fn((options: { level: string }) => ({
      level: options.level,
      info: vi.fn(),
      flush: vi.fn((done: () => void) => done()),
    })),
    {
      transport,
      stdTimeFunctions: { isoTime: () => "" },
      stdSerializers: { err: (err: unknown) => err },
    },
  );
  return { pino, transport };
});
vi.mock("pino", () => ({ default: pino }));

const scratch = mkdtempSync(join(tmpdir(), "ibmi-mcp-logger-"));
const notADirectory = join(scratch, "file");
writeFileSync(notADirectory, "");

const testConfig = {
  environment: "test",
  mcpTransportType: "http",
  mcpServerName: "test-server",
  logsPath: join(scratch, "logs"),
  logLevel: "debug",
};

vi.mock("../../../src/config/index.js", () => ({ config: testConfig }));

describe("logger", () => {
  const loadLogger = async (overrides: Partial<typeof testConfig> = {}) => {
    Object.assign(testConfig, overrides);
    vi.resetModules();
    return import("../../../src/utils/internal/logger.js");
  };

  /** The transport targets of the most recently built pino instance. */
  const lastTargets = () =>
    transport.mock.lastCall![0].targets as Array<{
      target: string;
      level: string;
      options: { file?: string; destination?: number };
    }>;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(testConfig, {
      environment: "test",
      mcpTransportType: "http",
      logsPath: join(scratch, "logs"),
      logLevel: "debug",
    });
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each([
    ["debug", "debug"],
    ["notice", "info"],
    ["warning", "warn"],
    ["warn", "warn"],
    ["emerg", "fatal"],
  ])("should map MCP_LOG_LEVEL=%s to pino level %s", async (mcp, level) => {
    const { logger } = await loadLogger({ logLevel: mcp });

    expect(logger.pino.level).toBe(level);
  });

  it("should not build a pino instance until something is logged", async () => {
    const logsPath = join(scratch, "not-created-on-import");
    const { logger } = await loadLogger({ logsPath });

    expect(pino).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(existsSync(logsPath)).toBe(false);

    logger.info("first record");
    logger.info("second record");

    expect(pino).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    expect(existsSync(logsPath)).toBe(true);
  });

  it("should write exactly combined.log at the configured level and error.log", async () => {
    const { logger } = await loadLogger({
      mcpTransportType: "stdio",
      logLevel: "notice",
    });

    logger.info("record");

    expect(
      lastTargets().map(({ target, level, options }) => ({
        target,
        level,
        file: options.file,
      })),
    ).toEqual([
      {
        target: "pino-roll",
        level: "info",
        file: join(testConfig.logsPath, "combined.log"),
      },
      {
        target: "pino-roll",
        level: "error",
        file: join(testConfig.logsPath, "error.log"),
      },
    ]);
  });

  describe("when LOGS_DIR cannot be created or written to", () => {
    it.each(["development", "production"])(
      "should log to stderr at warn level under stdio and say so once (NODE_ENV=%s)",
      async (environment) => {
        const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
        const { logger, reinitializeLogger } = await loadLogger({
          environment,
          mcpTransportType: "stdio",
          logsPath: join(notADirectory, "logs"),
        });

        expect(() => logger.info("record")).not.toThrow();

        // pino applies a lone target's level through the logger's own level.
        expect(logger.pino.level).toBe("warn");
        expect(lastTargets()).toEqual([
          {
            target: "pino/file",
            options: { destination: process.stderr.fd },
            level: "warn",
          },
        ]);
        expect(stderr).toHaveBeenCalledOnce();
        expect(stderr).toHaveBeenCalledWith(
          expect.stringMatching(
            /LOGS_DIR '.*file\/logs'.*File logging is disabled; logging to stderr at warn level instead\./,
          ),
        );

        reinitializeLogger();
        logger.info("record");

        expect(pino).toHaveBeenCalledTimes(2);
        expect(stderr).toHaveBeenCalledOnce();
        stderr.mockRestore();
      },
    );

    it("should keep the http console target at the configured level", async () => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      const { logger } = await loadLogger({
        environment: "production",
        logLevel: "info",
        logsPath: join(notADirectory, "logs"),
      });

      logger.info("record");

      expect(lastTargets()).toEqual([
        {
          target: "pino/file",
          options: { destination: process.stderr.fd },
          level: "info",
        },
      ]);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          "File logging is disabled; logging to stderr instead.",
        ),
      );
      stderr.mockRestore();
    });
  });

  it("should end the old transport on reinitializeLogger() and build a new instance on the next use", async () => {
    const { logger, reinitializeLogger } = await loadLogger({
      logLevel: "info",
    });
    const first = logger.pino;
    const firstTransport = transport.mock.results[0]!.value;

    testConfig.logLevel = "error";
    reinitializeLogger();

    expect(firstTransport.end).toHaveBeenCalledOnce();
    expect(pino).toHaveBeenCalledOnce();
    expect(logger.pino).not.toBe(first);
    expect(logger.pino.level).toBe("error");
  });

  it("should not build an instance when reinitializeLogger() runs before any log call", async () => {
    const { reinitializeLogger } = await loadLogger();

    reinitializeLogger();

    expect(pino).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("should not register process-level handlers: the entry point owns process exit", async () => {
    const before = process.listeners("uncaughtException").length;

    const { logger, reinitializeLogger } = await loadLogger();
    logger.info("record");
    reinitializeLogger();

    expect(process.listeners("uncaughtException")).toHaveLength(before);
  });

  it("should resolve flushLogger() once pino has flushed", async () => {
    const { logger, flushLogger } = await loadLogger();
    const instance = logger.pino;

    await flushLogger();

    expect(instance.flush).toHaveBeenCalledOnce();
  });

  it("should resolve flushLogger() without building an instance when nothing was logged", async () => {
    const { flushLogger } = await loadLogger();

    await flushLogger();

    expect(pino).not.toHaveBeenCalled();
  });
});
