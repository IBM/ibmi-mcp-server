/**
 * @fileoverview Provides a globally accessible, pre-configured Pino logger instance.
 * This module handles environment-aware logging, structured JSON output for production,
 * pretty-printing for development, and safe file-based logging for STDIO transports.
 * @module src/utils/internal/logger
 */
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

function createPinoLogger(): PinoLogger {
  const isProd = config.environment === "production";
  const isStdioTransport = config.mcpTransportType === "stdio";
  const resolvedLogsDir = config.logsPath;
  // MCP_LOG_LEVEL takes the MCP level names above; `warn` (pino's spelling of
  // `warning`) is also accepted because the README documented it through 0.6.x.
  const logLevel =
    config.logLevel === "warn"
      ? "warn"
      : mcpToPinoLevel[config.logLevel as McpLogLevel] || "info";

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

  // File logging: required for stdio/prod; optional for others when logs dir is available.
  if (isStdioTransport || isProd) {
    if (!resolvedLogsDir) {
      throw new Error(
        "Configuration Error: LOGS_DIR must be defined for STDIO transport or production environments.",
      );
    }
  }

  if (resolvedLogsDir) {
    // Combined rotating log file (JSON)
    targets.push({
      target: "pino-roll",
      options: {
        file: path.join(resolvedLogsDir, "combined.log"),
        frequency: "daily",
        mkdir: true,
        size: "10m",
        limit: { count: 5 },
      },
      level: "info",
    });

    // Level-specific rolling files
    targets.push(
      {
        target: "pino-roll",
        options: {
          file: path.join(resolvedLogsDir, "error.log"),
          frequency: "daily",
          mkdir: true,
          size: "10m",
          limit: { count: 5 },
        },
        level: "error",
      },
      {
        target: "pino-roll",
        options: {
          file: path.join(resolvedLogsDir, "warn.log"),
          frequency: "daily",
          mkdir: true,
          size: "10m",
          limit: { count: 5 },
        },
        level: "warn",
      },
      {
        target: "pino-roll",
        options: {
          file: path.join(resolvedLogsDir, "info.log"),
          frequency: "daily",
          mkdir: true,
          size: "10m",
          limit: { count: 5 },
        },
        level: "info",
      },
      {
        target: "pino-roll",
        options: {
          file: path.join(resolvedLogsDir, "debug.log"),
          frequency: "daily",
          mkdir: true,
          size: "10m",
          limit: { count: 5 },
        },
        level: "debug",
      },
    );
  }

  return pino({
    name: config.mcpServerName || "mcp-server",
    level: logLevel,
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
    transport: targets.length > 0 ? { targets } : undefined,
  });
}

let mainLogger = createPinoLogger();

// Set up a global uncaught exception handler to ensure fatal errors are logged before exit.
// Registered once here rather than per instance, so reinitializeLogger() does not
// stack listeners and the record goes to the current instance.
process.on("uncaughtException", (err) => {
  mainLogger.fatal(
    err,
    "Uncaught exception detected. The application will now exit.",
  );
  process.exit(1);
});

/**
 * Reinitialize the logger with updated configuration
 * Call this after CLI arguments are applied to config
 */
export function reinitializeLogger(): void {
  mainLogger = createPinoLogger();
}

// Wrapper function to preserve the original MCP log levels.
const logWrapper =
  (level: McpLogLevel) =>
  (obj: Error | Record<string, unknown> | string, msg?: string) => {
    const pinoLevel = mcpToPinoLevel[level];

    if (typeof obj === "string") {
      mainLogger[pinoLevel](obj);
    } else if (obj instanceof Error) {
      // Pino convention: pass error as 'err' property for the serializer to pick it up.
      mainLogger[pinoLevel]({ err: obj }, msg);
    } else {
      mainLogger[pinoLevel](obj, msg);
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
  // A getter, so it follows the instance swap done by reinitializeLogger().
  get pino(): PinoLogger {
    return mainLogger;
  },
};
