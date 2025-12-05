#!/usr/bin/env node
/**
 * @fileoverview Main entry point for the MCP TypeScript Template application.
 * This script initializes the configuration, sets up the logger, starts the
 * MCP server (either via STDIO or HTTP transport), and handles graceful
 * shutdown on process signals or unhandled errors.
 * @module src/index
 */

// IMPORTANT: This line MUST be the first import to ensure OpenTelemetry is
// initialized before any other modules are loaded.
import { shutdownOpenTelemetry } from "@/utils/telemetry/instrumentation.js";

import { config, environment } from "@/config/index.js";
import { initializeAndStartServer } from "@/mcp-server/server.js";
import { requestContextService } from "@/utils/index.js";
import {
  logFatal,
  logOperationError,
  logOperationStart,
  logOperationSuccess,
} from "@/utils/internal/logging-helpers.js";
import { logger } from "@/utils/internal/logger.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import http from "http";
import { statSync, existsSync } from "fs";
import { applyCliOverrides } from "./config/resolver.js";
import {
  parseCliArguments,
  showHelp,
  validateToolsPath,
} from "./ibmi-mcp-server/utils/cli/argumentParser.js";
import { ToolProcessor } from "@/ibmi-mcp-server/utils/config/toolProcessor.js";
import { GLOBAL_TOOLS } from "./ibmi-mcp-server/utils/config/toolsetManager.js";

/**
 * List all available toolsets from YAML configuration and exit
 * This command parses the YAML tools configuration and displays a formatted list of all toolsets
 */
async function listToolsetsCommand(): Promise<void> {
  logger.info("\n📦 Available Toolsets\n");

  try {
    // Apply CLI overrides to get the correct tools path
    applyCliOverrides(cliArgs);

    if (!config.toolsYamlPath) {
      logger.error("❌ No YAML tools configuration found.");
      logger.error(
        "   Use --tools <path> to specify YAML tools configuration or set TOOLS_YAML_PATH environment variable.\n",
      );
      return;
    }

    logger.info(`📁 Configuration: ${config.toolsYamlPath}`);
    logger.info("");

    // Create a context for this operation
    const context = requestContextService.createRequestContext({
      operation: "ListToolsets",
      yamlPath: config.toolsYamlPath,
    });

    // Parse YAML configuration to extract toolsets using ToolProcessor
    // Determine the appropriate method based on the path type
    let configResult;
    if (Array.isArray(config.toolsYamlPath)) {
      configResult = await ToolProcessor.fromFiles(
        config.toolsYamlPath,
        context,
      );
    } else if (existsSync(config.toolsYamlPath)) {
      const stats = statSync(config.toolsYamlPath);
      if (stats.isDirectory()) {
        configResult = await ToolProcessor.fromDirectory(
          config.toolsYamlPath,
          context,
        );
      } else {
        configResult = await ToolProcessor.fromFile(
          config.toolsYamlPath,
          context,
        );
      }
    } else {
      logger.error(`❌ Path does not exist: ${config.toolsYamlPath}`);
      return;
    }

    if (!configResult.success || !configResult.config) {
      logger.error("❌ Failed to parse YAML configuration:");
      if (configResult.errors) {
        configResult.errors.forEach((error) => logger.error(`   ${error}`));
      }
      return;
    }

    const yamlConfig = configResult.config;

    // Display global tools section
    logger.info("🌍 Global Tools (automatically added to all toolsets):");
    logger.info(`   • ${GLOBAL_TOOLS}`);
    logger.info("");

    if (!yamlConfig.toolsets || Object.keys(yamlConfig.toolsets).length === 0) {
      logger.info("ℹ️  No toolsets found in YAML configuration.");
      logger.info(
        "   Individual tools may be available without being organized into toolsets.\n",
      );
      return;
    }

    // Display toolsets information
    logger.info(`Found ${Object.keys(yamlConfig.toolsets).length} toolsets:\n`);

    for (const [toolsetName, toolsetConfig] of Object.entries(
      yamlConfig.toolsets,
    )) {
      const toolsetToolCount = toolsetConfig.tools
        ? toolsetConfig.tools.length
        : 0;
      const globalToolCount = GLOBAL_TOOLS.length;
      const totalToolCount = toolsetToolCount;

      logger.info(`🔧 ${toolsetName}`);

      if (toolsetConfig.title && toolsetConfig.title !== toolsetName) {
        logger.info(`   Title: ${toolsetConfig.title}`);
      }

      if (toolsetConfig.description) {
        logger.info(`   Description: ${toolsetConfig.description}`);
      }

      logger.info(
        `   Tools: ${totalToolCount} tools (${toolsetToolCount} specific + ${globalToolCount} global)`,
      );

      if (toolsetToolCount > 0) {
        logger.info(`   Specific tools: ${toolsetConfig.tools.join(", ")}`);
      }

      logger.info("");
    }

    logger.info("💡 Usage examples:");
    logger.info(
      `   npx ibmi-mcp-server --tools ${config.toolsYamlPath} --toolsets ${Object.keys(yamlConfig.toolsets).slice(0, 2).join(",")}`,
    );
    logger.info(
      `   npm run start:http -- --tools ${config.toolsYamlPath} --toolsets ${Object.keys(yamlConfig.toolsets)[0]}`,
    );
    logger.info("");
  } catch (error) {
    logger.error("❌ Error listing toolsets:");
    logger.error(
      `   ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Parse CLI arguments and handle immediate responses
const cliArgs = parseCliArguments();

// Handle help request immediately
if (cliArgs.help) {
  showHelp();
  process.exit(0);
}

// Handle list toolsets request immediately
if (cliArgs.listToolsets) {
  await listToolsetsCommand();
  process.exit(0);
}

// Handle any parsing errors
if (cliArgs.errors && cliArgs.errors.length > 0) {
  logger.error("CLI Argument Errors:");
  cliArgs.errors.forEach((error) => logger.error(`  ✘ ${error}`));
  process.exit(1);
}

// Show warnings but continue execution
if (cliArgs.warnings && cliArgs.warnings.length > 0) {
  logger.warning("CLI Argument Warnings:");
  cliArgs.warnings.forEach((warning) => logger.warning(`  ⚠ ${warning}`));
}

// Validate tools path if provided
if (cliArgs.tools) {
  const validation = validateToolsPath(cliArgs.tools);
  if (!validation.valid) {
    logger.error(`Tools path validation failed: ${validation.message}`);
    process.exit(1);
  }
  if (validation.message) {
    logger.info(`ℹ ${validation.message}`);
  }
}

// Apply CLI overrides directly to global config so downstream modules see changes
applyCliOverrides(cliArgs);

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

let mcpStdioServer: McpServer | undefined;
let actualHttpServer: http.Server | undefined;

const shutdown = async (signal: string): Promise<void> => {
  const shutdownContext = requestContextService.createRequestContext({
    operation: "ServerShutdown",
    triggerEvent: signal,
  });

  logOperationStart(
    shutdownContext,
    `Received ${signal}. Initiating graceful shutdown...`,
  );

  try {
    await shutdownOpenTelemetry();

    let closePromise: Promise<void> = Promise.resolve();
    const transportType = config.mcpTransportType;

    if (transportType === "stdio" && mcpStdioServer) {
      logOperationStart(
        shutdownContext,
        "Attempting to close main MCP server (STDIO)...",
      );
      closePromise = mcpStdioServer.close();
    } else if (transportType === "http" && actualHttpServer) {
      logOperationStart(shutdownContext, "Attempting to close HTTP server...");
      closePromise = new Promise((resolve, reject) => {
        actualHttpServer!.close((err) => {
          if (err) {
            logOperationError(
              shutdownContext,
              "Error closing HTTP server.",
              err,
            );
            return reject(err);
          }
          logOperationSuccess(
            shutdownContext,
            "HTTP server closed successfully.",
          );
          resolve();
        });
      });
    }

    await closePromise;
    // Cleanup YAML watchers before exit
    try {
      ToolProcessor.clearWatchers();
    } catch {
      // best-effort
    }
    logOperationSuccess(
      shutdownContext,
      "Graceful shutdown completed successfully. Exiting.",
    );
    process.exit(0);
  } catch (error) {
    logOperationError(
      shutdownContext,
      "Critical error during shutdown process.",
      error,
    );
    try {
      ToolProcessor.clearWatchers();
    } catch {
      // best-effort
    }
    process.exit(1);
  }
};

const start = async (): Promise<void> => {
  const transportType = config.mcpTransportType;
  const startupContext = requestContextService.createRequestContext({
    operation: `ServerStartupSequence_${transportType}`,
    applicationName: config.mcpServerName,
    applicationVersion: config.mcpServerVersion,
    nodeEnvironment: environment,
  });

  logOperationStart(
    startupContext,
    `Starting ${config.mcpServerName} (Version: ${config.mcpServerVersion}, Transport: ${transportType}, Env: ${environment})...`,
  );

  try {
    const serverInstance = await initializeAndStartServer();

    if (transportType === "stdio" && serverInstance instanceof McpServer) {
      mcpStdioServer = serverInstance;
    } else if (
      transportType === "http" &&
      serverInstance instanceof http.Server
    ) {
      actualHttpServer = serverInstance;
    }

    logOperationSuccess(
      startupContext,
      `${config.mcpServerName} is now running and ready.`,
    );

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // The logger already has a global uncaughtException handler for logging.
    // This handler is for initiating a graceful shutdown.
    process.on("uncaughtException", (error: Error) => {
      const context = requestContextService.createRequestContext({
        operation: "uncaughtException",
      });
      logFatal(context, "FATAL: Uncaught exception triggered shutdown.", error);
      shutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason: unknown) => {
      const context = requestContextService.createRequestContext({
        operation: "unhandledRejection",
      });
      logFatal(
        context,
        "FATAL: Unhandled promise rejection triggered shutdown.",
        reason,
      );
      shutdown("unhandledRejection");
    });
  } catch (error) {
    logFatal(startupContext, "CRITICAL ERROR DURING STARTUP.", error);
    await shutdownOpenTelemetry(); // Attempt to flush any startup-related traces
    process.exit(1);
  }
};

(async () => {
  try {
    await start();
  } catch (error) {
    const context = requestContextService.createRequestContext({
      operation: "globalCatch",
    });
    logFatal(
      context,
      "[GLOBAL CATCH] A fatal, unhandled error occurred.",
      error,
    );
    try {
      ToolProcessor.clearWatchers();
    } catch {
      // ignore
    }
    process.exit(1);
  }
})();
