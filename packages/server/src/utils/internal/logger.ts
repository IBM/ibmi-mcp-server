/**
 * @fileoverview Provides a globally accessible, pre-configured Pino logger instance.
 * This module handles environment-aware logging, structured JSON output for production,
 * pretty-printing for development, and safe file-based logging for STDIO transports.
 *
 * The pino instance is built on the first log call: importing this module
 * creates no directories, files or worker threads.
 * @module src/utils/internal/logger
 */
import { accessSync, constants, mkdirSync } from "fs";
import os from "os";
import path from "path";
import pino, {
  type Logger as PinoLogger,
  type TransportTargetOptions,
} from "pino";
import { config } from "../../config/index.js";

export type McpLogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "crit"
  | "alert"
  | "emerg";

// Pino levels are 'trace', 'debug', 'info', 'warn', 'error', 'fatal'.
// We map our custom MCP levels to these.
const mcpToPinoLevel: Record<McpLogLevel, pino.LevelWithSilent> = {
  debug: "debug",
  info: "info",
  notice: "info",
  warning: "warn",
  error: "error",
  crit: "fatal",
  alert: "fatal",
  emerg: "fatal",
};

/**
 * Creates the logs directory if needed and checks that it can be written to:
 * a file transport pointed at a read-only directory blocks the event loop
 * while it fails to flush.
 * @returns Why the directory cannot be used, or undefined when it can.
 */
function logsDirProblem(dir: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

let mainLogger: PinoLogger | undefined;
let mainTransport: ReturnType<typeof pino.transport> | undefined;
let warnedAboutLogsDir = false;

function createPinoLogger(): PinoLogger {
  const isProd = config.environment === "production";
  const isStdioTransport = config.mcpTransportType === "stdio";
  const logsDir = config.logsPath;
  // MCP_LOG_LEVEL takes the MCP level names above; `warn` (pino's spelling of
  // `warning`) is also accepted because the README documented it through 0.6.x.
  const logLevel =
    config.logLevel === "warn" ? "warn" : mcpToPinoLevel[config.logLevel];

  // Build a transport target list so we can combine console + file outputs.
  const targets: TransportTargetOptions[] = [];

  // CRITICAL: STDIO transport MUST NOT output colored logs to stdout.
  // The MCP specification requires clean JSON-RPC on stdout with no ANSI codes.
  // Respect NO_COLOR environment variable (https://no-color.org/)
  const noColorEnv =
    process.env.NO_COLOR === "1" || process.env.FORCE_COLOR === "0";
  const useColoredOutput =
    !isProd && process.stdout.isTTY && !isStdioTransport && !noColorEnv;

  // Console output: colored pretty-print or plain JSON to stderr
  // NEVER output to stdout in any mode (reserved for JSON-RPC in STDIO)
  if (useColoredOutput) {
    // Colored pretty-printing for dev with HTTP transport
    targets.push({
      target: "pino-pretty",
      options: {
        colorize: true,
        destination: process.stderr.fd,
        ignore: "pid,hostname,env,name",
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
      },
      level: "debug",
    });
  } else if (!isStdioTransport) {
    // Plain JSON to stderr when colors disabled (NO_COLOR, prod, etc.)
    // Skip for STDIO transport to keep stderr quieter (logs go to files only)
    targets.push({
      target: "pino/file",
      options: {
        destination: process.stderr.fd,
      },
      level: logLevel,
    });
  }

  let level = logLevel;

  // File logging: combined.log at the configured level, error.log for errors.
  const problem = logsDirProblem(logsDir);
  if (problem === undefined) {
    for (const [file, fileLevel] of [
      ["combined.log", logLevel],
      ["error.log", "error"],
    ] as const) {
      targets.push({
        target: "pino-roll",
        options: {
          file: path.join(logsDir, file),
          frequency: "daily",
          mkdir: true,
          size: "10m",
          limit: { count: 5 },
        },
        level: fileLevel,
      });
    }
  } else {
    // An unusable LOGS_DIR never stops the process. The stdio transport has no
    // console target, so its warnings and errors go to stderr instead.
    if (isStdioTransport) {
      // pino ignores the level of a lone target, so the logger's level is
      // what keeps debug and info records off stderr.
      level = "warn";
      targets.push({
        target: "pino/file",
        options: {
          destination: process.stderr.fd,
        },
        level,
      });
    }
    if (!warnedAboutLogsDir) {
      warnedAboutLogsDir = true;
      console.error(
        `Warning: cannot write logs to LOGS_DIR '${logsDir}' (${problem}). File logging is disabled; logging to stderr${isStdioTransport ? " at warn level" : ""} instead.`,
      );
    }
  }

  mainTransport = pino.transport({ targets });

  return pino(
    {
      name: config.mcpServerName || "mcp-server",
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "password",
          "token",
          "apiKey",
          "secret",
          "authorization",
          "cookie",
        ],
        censor: "[REDACTED]",
      },
      base: {
        pid: process.pid,
        hostname: os.hostname(),
        env: config.environment,
      },
      // Use Pino's standard error serializer for robust error logging.
      serializers: {
        err: pino.stdSerializers.err,
      },
    },
    mainTransport,
  );
}

function getLogger(): PinoLogger {
  return (mainLogger ??= createPinoLogger());
}

/**
 * Drops the current pino instance, ending its transport, so the next log call
 * builds one from the current configuration. Call this after CLI arguments
 * are applied to config.
 */
export function reinitializeLogger(): void {
  mainTransport?.end();
  mainTransport = undefined;
  mainLogger = undefined;
}

/**
 * Resolves once buffered log records have been handed to the transports.
 * Call before exiting the process; the logger itself never exits.
 */
export function flushLogger(): Promise<void> {
  const current = mainLogger;
  if (!current) {
    return Promise.resolve();
  }
  return new Promise((resolve) => current.flush(() => resolve()));
}

// Wrapper function to preserve the original MCP log levels.
const logWrapper =
  (level: McpLogLevel) =>
  (obj: Error | Record<string, unknown> | string, msg?: string) => {
    const pinoLevel = mcpToPinoLevel[level];

    if (typeof obj === "string") {
      getLogger()[pinoLevel](obj);
    } else if (obj instanceof Error) {
      // Pino convention: pass error as 'err' property for the serializer to pick it up.
      getLogger()[pinoLevel]({ err: obj }, msg);
    } else {
      getLogger()[pinoLevel](obj, msg);
    }
  };

export const logger = {
  debug: logWrapper("debug"),
  info: logWrapper("info"),
  notice: logWrapper("notice"),
  warning: logWrapper("warning"),
  error: logWrapper("error"),
  crit: logWrapper("crit"),
  alert: logWrapper("alert"),
  emerg: logWrapper("emerg"),
  fatal: logWrapper("emerg"), // Alias fatal to emerg for convenience

  // Expose the raw pino instance for advanced use cases, like passing to other libraries.
  // A getter, so it always returns the current instance.
  get pino(): PinoLogger {
    return getLogger();
  },
};
