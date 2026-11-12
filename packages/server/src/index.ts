#!/usr/bin/env node
/**
 * @fileoverview Main entry point for the IBM i MCP Server.
 * This script initializes the configuration, sets up the logger, starts the
 * MCP server (either via STDIO or HTTP transport), and handles graceful
 * shutdown on process signals or unhandled errors.
 * @module src/index
 */

// The only static imports: the argument parser, which loads nothing else, and
// types. The server is loaded further down, after the commands that answer
// without it (--help, --admin).
import {
  type CliArguments,
  parseCliArguments,
  showHelp,
} from "./ibmi-mcp-server/utils/cli/argumentParser.js";
import type { RunningServer } from "@/mcp-server/server.js";
import type { RequestContext } from "@/utils/internal/requestContext.js";

// Parse CLI arguments and handle immediate responses. A problem with the
// arguments goes straight to stderr (the logger has no console target in
// stdio mode, the default) and comes before everything else, --list-toolsets
// included.
let cliArgs: CliArguments;
try {
  cliArgs = parseCliArguments();
} catch (error) {
  console.error(
    `Invalid arguments: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error("Run with --help for usage.");
  process.exit(1);
}

// Handle help request immediately
if (cliArgs.help) {
  showHelp();
  process.exit(0);
}

/**
 * Sends one command to the admin socket of a running server and prints its
 * one-line reply. Loads the configuration (for `OAUTH_ADMIN_SOCKET`) and the
 * socket client, not the server.
 *
 * @returns The exit code: 0 when the server carried the command out.
 */
async function adminCommand(command: string): Promise<number> {
  const { config } = await import("./config/index.js");
  const { sendAdminCommand } =
    await import("./ibmi-mcp-server/oauth/adminSocket.js");
  const path = config.oauth.adminSocket;
  if (!path) {
    console.error(
      "OAUTH_ADMIN_SOCKET is not set. Set it to the admin socket of the running server.",
    );
    return 1;
  }
  try {
    const reply = await sendAdminCommand(path, command);
    if (reply.startsWith("error:")) {
      console.error(reply);
      return 1;
    }
    console.log(reply);
    return 0;
  } catch (error) {
    console.error(
      `No answer from the admin socket ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (cliArgs.admin !== undefined) {
  process.exit(await adminCommand(cliArgs.admin));
}

// From here on the server is loaded. First: the OTel facade (it lazy-loads
// the SDK only when OTEL_ENABLED=true).
const { openTelemetryStartupError, shutdownOpenTelemetry } =
  await import("./utils/telemetry/instrumentation.js");
const { config, environment, environmentIsValid } =
  await import("./config/index.js");
const { initializeAndStartServer } = await import("./mcp-server/server.js");
const { requestContextService } = await import("./utils/index.js");
const { logFatal, logOperationError, logOperationStart, logOperationSuccess } =
  await import("./utils/internal/logging-helpers.js");
const { flushLogger, logger, reinitializeLogger } =
  await import("./utils/internal/logger.js");
const { applyCliOverrides } = await import("./config/resolver.js");
const { ToolConfigBuilder } =
  await import("./ibmi-mcp-server/utils/config/toolConfigBuilder.js");
const { ToolProcessor } =
  await import("./ibmi-mcp-server/utils/config/toolProcessor.js");
const { BaseConnectionPool } =
  await import("./ibmi-mcp-server/services/baseConnectionPool.js");
const { GLOBAL_TOOLS } =
  await import("./ibmi-mcp-server/utils/config/toolsetManager.js");

/**
 * List all available toolsets from YAML configuration and exit
 * This command parses the YAML tools configuration and displays a formatted list of all toolsets
 *
 * Writes to stdout/stderr directly: the logger has no console target in stdio
 * mode (the default), and this runs before any transport starts, so stdout is
 * not yet the MCP protocol stream.
 *
 * @returns true if the toolsets were listed, false on failure
 */
async function listToolsetsCommand(): Promise<boolean> {
  console.log("\n📦 Available Toolsets\n");

  try {
    // Apply CLI overrides to get the correct tools path
    applyCliOverrides(cliArgs);
    reinitializeLogger();

    if (!config.toolsYamlPath) {
      console.error("❌ No YAML tools configuration found.");
      console.error(
        "   Use --tools <path> to specify YAML tools configuration or set TOOLS_YAML_PATH environment variable.\n",
      );
      return false;
    }

    console.log(`📁 Configuration: ${config.toolsYamlPath}`);
    console.log("");

    // Create a context for this operation
    const context = requestContextService.createRequestContext({
      operation: "ListToolsets",
      yamlPath: config.toolsYamlPath,
    });

    // Resolve and parse the tools path (file, directory or glob) the way the
    // server does at startup, except that the variables the sources name
    // (credentials, as a rule) need not be set: nothing connects here.
    const { config: yamlConfig } = await ToolConfigBuilder.fromPath(
      config.toolsYamlPath,
      context,
      { allowUnsetVariables: true },
    );

    // Display global tools section
    console.log("🌍 Global Tools (automatically added to all toolsets):");
    console.log(`   • ${GLOBAL_TOOLS.join(", ")}`);
    console.log("");

    if (!yamlConfig.toolsets || Object.keys(yamlConfig.toolsets).length === 0) {
      console.log("ℹ️  No toolsets found in YAML configuration.");
      console.log(
        "   Individual tools may be available without being organized into toolsets.\n",
      );
      return true;
    }

    // Display toolsets information
    console.log(`Found ${Object.keys(yamlConfig.toolsets).length} toolsets:\n`);

    for (const [toolsetName, toolsetConfig] of Object.entries(
      yamlConfig.toolsets,
    )) {
      const toolsetToolCount = toolsetConfig.tools
        ? toolsetConfig.tools.length
        : 0;
      const globalToolCount = GLOBAL_TOOLS.length;
      const totalToolCount = toolsetToolCount + globalToolCount;

      console.log(`🔧 ${toolsetName}`);

      if (toolsetConfig.title && toolsetConfig.title !== toolsetName) {
        console.log(`   Title: ${toolsetConfig.title}`);
      }

      if (toolsetConfig.description) {
        console.log(`   Description: ${toolsetConfig.description}`);
      }

      console.log(
        `   Tools: ${totalToolCount} tools (${toolsetToolCount} specific + ${globalToolCount} global)`,
      );

      if (toolsetToolCount > 0) {
        console.log(`   Specific tools: ${toolsetConfig.tools.join(", ")}`);
      }

      console.log("");
    }

    console.log("💡 Usage examples:");
    console.log(
      `   npx @ibm/ibmi-mcp-server --tools ${config.toolsYamlPath} --toolsets ${Object.keys(yamlConfig.toolsets).slice(0, 2).join(",")}`,
    );
    console.log(
      `   npm run start:http -- --tools ${config.toolsYamlPath} --toolsets ${Object.keys(yamlConfig.toolsets)[0]}`,
    );
    console.log("");
    return true;
  } catch (error) {
    console.error("❌ Error listing toolsets:");
    console.error(
      `   ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// Handle list toolsets request immediately
if (cliArgs.listToolsets) {
  const listed = await listToolsetsCommand();
  process.exit(listed ? 0 : 1);
}

// An invalid environment leaves every setting at its default (the config
// module has reported which variables are at fault). A server must not run
// with settings its operator did not choose.
if (!environmentIsValid) {
  console.error(
    `${config.mcpServerName}: Startup failed. Fix the invalid environment variables reported above.`,
  );
  process.exit(1);
}

// Apply CLI overrides directly to global config so downstream modules see changes
applyCliOverrides(cliArgs);

// Reinitialize logger with updated config (especially transport mode from CLI)
reinitializeLogger();

if (
  process.env.MCP_SESSION_MODE &&
  process.env.MCP_SESSION_MODE !== "stateless"
) {
  console.error(
    "Warning: MCP_SESSION_MODE is ignored; this server is stateless.",
  );
}

// In stdio mode stdout carries the JSON-RPC stream. Dependencies that print
// with console.log (mapepire-js does on socket errors) would corrupt it, so
// send console output to stderr instead.
if (config.mcpTransportType === "stdio") {
  console.log = console.info = console.debug = console.error;
}

// Log overrides if provided
if (cliArgs.tools) {
  logger.info(`ℹ Using tools path: ${config.toolsYamlPath}`);
}
if (cliArgs.transport) {
  logger.info(`ℹ Using MCP transport type: ${config.mcpTransportType}`);
}

if (cliArgs.toolsets && cliArgs.toolsets.length > 0) {
  logger.info(`ℹ Using toolsets: ${cliArgs.toolsets.join(", ")}`);
}

/** How long a shutdown may take before the process exits anyway. */
const SHUTDOWN_DEADLINE_MS = 10_000;

let runningServer: RunningServer | undefined;
let shuttingDown = false;

/**
 * The only place the running server exits the process. Closes the transport
 * (which also ends every IBM i profile sign-on and closes its job), the
 * connection pools, the YAML file watchers and telemetry, flushes the
 * logger, then exits. A step that hangs is cut off by the deadline.
 *
 * @param signal - What triggered the shutdown, for the log.
 * @param exitCode - 0 for a requested stop, non-zero on fatal paths.
 */
const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  setTimeout(() => process.exit(exitCode || 1), SHUTDOWN_DEADLINE_MS).unref();

  const context: RequestContext = requestContextService.createRequestContext({
    operation: "ServerShutdown",
    triggerEvent: signal,
  });
  logOperationStart(context, `Shutting down (${signal})...`);

  // Each step runs even if an earlier one failed.
  const steps: Array<[string, () => Promise<void> | void]> = [
    ["transport", () => runningServer?.close()],
    ["IBM i connection pools", () => BaseConnectionPool.shutdownAll(context)],
    ["YAML file watchers", () => ToolProcessor.clearWatchers()],
    ["telemetry", () => shutdownOpenTelemetry()],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      logOperationError(context, `Error closing ${name}.`, error);
      exitCode ||= 1;
    }
  }

  logOperationSuccess(context, "Shutdown complete. Exiting.");
  await flushLogger();
  process.exit(exitCode);
};

/** Logs a fatal error, reports it on stderr and shuts down with exit code 1. */
const fail = (message: string, error: unknown): Promise<void> => {
  logFatal(
    requestContextService.createRequestContext({ operation: "FatalError" }),
    message,
    error,
  );
  // One line on stderr: in stdio mode the logger writes to files only.
  console.error(
    `${config.mcpServerName}: ${message} ${error instanceof Error ? error.message : String(error)}`,
  );
  return shutdown(message, 1);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on(
  "uncaughtException",
  (error) => void fail("Uncaught exception.", error),
);
process.on("unhandledRejection", (reason) => {
  if (config.oauth.builtin) {
    // Users are signed on with their IBM i profile and a restart signs every
    // one of them out: one failed promise is logged and the server goes on.
    // An uncaught exception still exits.
    logOperationError(
      requestContextService.createRequestContext({
        operation: "UnhandledRejection",
      }),
      "Unhandled promise rejection.",
      reason,
      { event: "unhandled_rejection" },
    );
    return;
  }
  void fail("Unhandled promise rejection.", reason);
});

const startupContext = requestContextService.createRequestContext({
  operation: `ServerStartupSequence_${config.mcpTransportType}`,
  applicationName: config.mcpServerName,
  applicationVersion: config.mcpServerVersion,
  nodeEnvironment: environment,
});
logOperationStart(
  startupContext,
  `Starting ${config.mcpServerName} (Version: ${config.mcpServerVersion}, Transport: ${config.mcpTransportType}, Env: ${environment})...`,
);

try {
  if (openTelemetryStartupError) {
    throw openTelemetryStartupError;
  }
  runningServer = await initializeAndStartServer();
  if (config.mcpTransportType === "stdio") {
    // The client closing stdin is the portable way to stop a stdio server.
    // Open connection pools would otherwise keep the process alive.
    process.stdin.once("end", () => void shutdown("stdin closed"));
  }
  logOperationSuccess(
    startupContext,
    `${config.mcpServerName} is now running and ready.`,
  );
} catch (error) {
  await fail("Startup failed.", error);
}
