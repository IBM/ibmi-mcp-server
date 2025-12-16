/**
 * @fileoverview Provides a globally accessible, pre-configured Pino logger instance.
 * This module handles environment-aware logging, structured JSON output for production,
 * pretty-printing for development, and safe file-based logging for STDIO transports.
 * It integrates with the async context to automatically enrich logs with request details.
 * @module src/utils/internal/logger
 */
import os from "os";
import path from "path";
import pino, {
  type Logger as PinoLogger,
  type TransportTargetOptions,
} from "pino";
import { config } from "../../config/index.js";
import { getRequestContext } from "./asyncContext.js";
import { RequestContext } from "./requestContext.js";

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

export interface McpLogPayload {
  message: string;
  context?: RequestContext;
  error?: {
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

export type McpNotificationData = McpLogPayload | Record<string, unknown>;

export type McpNotificationSender = (
  level: McpLogLevel,
  data: McpNotificationData,
  loggerName?: string,
) => void;

let mcpNotificationSender: McpNotificationSender | undefined;

function createPinoLogger(): PinoLogger {
  const isProd = config.environment === "production";
  const isStdioTransport = config.mcpTransportType === "stdio";
  const resolvedLogsDir = config.logsPath;
  const logLevel = mcpToPinoLevel[config.logLevel as McpLogLevel] || "info";

  // Build a transport target list so we can combine console + file outputs.
  const targets: TransportTargetOptions[] = [];

  // Console pretty printing for local dev (non-prod)
  if (!isProd && process.stdout.isTTY) {
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
  }

  // File logging: required for stdio/prod; optional for others when logs dir is available.
  if (isStdioTransport || isProd) {
    if (!resolvedLogsDir) {
      throw new Error(
        "Configuration Error: LOGS_PATH must be defined for STDIO transport or production environments.",
      );
    }
  }

  if (resolvedLogsDir) {
    // Combined rotating log file (JSON) similar to previous combined.log
    targets.push({
      target: "pino-roll",
      options: {
        file: path.join(resolvedLogsDir, "combined.log"),
        frequency: "daily",
        mkdir: true,
        size: "10m",
        files: 5,
      },
      level: "info",
    });

    // Level-specific rolling files to mirror prior Winston setup
    targets.push(
      {
        target: "pino-roll",
        options: {
          file: path.join(resolvedLogsDir, "error.log"),
          frequency: "daily",
          mkdir: true,
          size: "10m",
          files: 5,
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
          files: 5,
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
          files: 5,
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
          files: 5,
        },
        level: "debug",
      },
    );
  }

  const pinoInstance = pino({
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
    // Automatically add request context to every log message via async local storage.
    // mixin() {
    //   return getRequestContext() ?? {};
    // },
    // Use Pino's standard error serializer for robust error logging.
    serializers: {
      err: pino.stdSerializers.err,
    },
    transport: targets.length > 0 ? { targets } : undefined,
  });

  // Set up a global uncaught exception handler to ensure fatal errors are logged before exit.
  process.on("uncaughtException", (err) => {
    pinoInstance.fatal(
      err,
      "Uncaught exception detected. The application will now exit.",
    );
    process.exit(1);
  });

  return pinoInstance;
}

const mainLogger = createPinoLogger();

// Create a dedicated logger for interaction-specific logs.
// Create a dedicated interaction logger that writes to interactions.log if logsPath is available.
let interactionLogger: PinoLogger;
if (config.logsPath) {
  const interactionLogLevel =
    mcpToPinoLevel[config.logLevel as McpLogLevel] || "info";
  interactionLogger = pino({
    name: `${config.mcpServerName || "mcp-server"}-interactions`,
    level: interactionLogLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: {
      targets: [
        {
          target: "pino-roll",
          options: {
            file: path.join(config.logsPath, "interactions.log"),
            frequency: "daily",
            mkdir: true,
            size: "10m",
            files: 5,
          },
          level: "info",
        },
      ],
    },
  });
} else {
  interactionLogger = mainLogger.child({ name: "interaction-logger" });
}

// Wrapper function to preserve the original MCP log levels and handle notifications.
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

    if (mcpNotificationSender) {
      const payload: McpLogPayload = {
        message:
          typeof obj === "string"
            ? obj
            : msg || (obj as Error).message || "No message provided.",
        context: getRequestContext(),
      };
      if (typeof obj === "object" && obj !== null) {
        Object.assign(payload, obj);
      }
      mcpNotificationSender(level, payload, config.mcpServerName);
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

  logInteraction: (interactionName: string, data: Record<string, unknown>) => {
    interactionLogger.info({ interactionName, ...data });
  },

  setMcpNotificationSender: (sender: McpNotificationSender | undefined) => {
    mcpNotificationSender = sender;
  },

  setLevel: (newLevel: McpLogLevel) => {
    if (mcpToPinoLevel[newLevel]) {
      mainLogger.level = mcpToPinoLevel[newLevel];
    } else {
      mainLogger.warn(
        `Invalid MCP log level provided: ${newLevel}. Log level remains unchanged.`,
      );
    }
  },

  // Expose the raw pino instance for advanced use cases, like passing to other libraries.
  pino: mainLogger,
};
