import { config } from "@/config/index.js";
import { ToolProcessor } from "./utils/config/toolProcessor.js";
import { ToolConfigCache } from "./utils/config/toolConfigCache.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  logger,
  requestContextService,
  RequestContext,
} from "@/utils/internal/index.js";

// Store server replacement callback for auto-reload
let serverReplacementCallback: ((newServer: McpServer) => void) | null = null;

// Global cache for YAML tool configurations
let cachedToolConfigs: ToolConfigCache | null = null;

// Global tool processor instance
let toolProcessor: ToolProcessor | null = null;

/**
 * Set the server replacement callback for auto-reload functionality
 * This should be called by transport managers that support server replacement
 */
export const setServerReplacementCallback = (
  callback: (newServer: McpServer) => void,
): void => {
  serverReplacementCallback = callback;
  logger.debug(
    {},
    "Server replacement callback registered for YAML auto-reload",
  );
};

export const registerSQLTools = async (server: McpServer): Promise<void> => {
  // Load YAML tools if configured
  if (config.toolsYamlPath) {
    const context = requestContextService.createRequestContext({
      operation: "registerSQLTools",
      yamlPath: config.toolsYamlPath,
    });

    // Check if we have cached tool configs
    if (cachedToolConfigs && !cachedToolConfigs.isEmpty()) {
      logger.info(
        context,
        `Registering ${cachedToolConfigs.getStats().toolCount} cached YAML tools (cache hit)`,
      );

      // Register tools from cache - this is extremely fast
      await cachedToolConfigs.registerCachedTools(server, context);

      return;
    }

    logger.info(
      context,
      `Processing YAML tools from configuration: ${config.toolsYamlPath} (auto-reload: ${config.yamlAutoReload})`,
    );

    // Initialize processor if needed
    if (!toolProcessor) {
      toolProcessor = new ToolProcessor();
    }

    // Initialize cache if needed
    if (!cachedToolConfigs) {
      cachedToolConfigs = ToolConfigCache.getInstance();
    }

    try {
      // Simple 3-step workflow: initialize → process → register
      await toolProcessor.initialize(context);
      const processingResult = await toolProcessor.processTools(context);

      if (processingResult.success) {
        // Cache the processed tool configurations
        const toolConfigs = toolProcessor.getToolConfigurations();
        const cacheResult = cachedToolConfigs.cacheToolConfigs(
          toolConfigs,
          context,
        );

        if (cacheResult.success) {
          logger.info(
            context,
            `YAML tools processed and cached: ${cacheResult.toolCount} tools, ${cacheResult.toolsetCount} toolsets`,
          );

          // Register with server
          await toolProcessor.registerWithServer(server, context);

          // Setup auto-reload if enabled
          if (config.yamlAutoReload) {
            await setupAutoReload(server, context);
          }
        } else {
          logger.error(
            context,
            `Failed to cache tool configurations: ${cacheResult.error}`,
          );
          throw new Error(`Tool caching failed: ${cacheResult.error}`);
        }
      } else {
        logger.error(
          context,
          `Failed to process YAML tools: ${processingResult.error}`,
        );
        throw new Error(
          `YAML tools processing failed: ${processingResult.error}`,
        );
      }
    } catch (error) {
      logger.error(
        context,
        `Error processing YAML tools: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  } else {
    logger.debug(
      {},
      "No YAML tools configuration found, skipping YAML tools loading",
    );
  }
};

/**
 * Setup auto-reload functionality for YAML configuration changes
 * @param server - MCP server instance
 * @param context - Request context
 * @private
 */
async function setupAutoReload(
  server: McpServer,
  context: RequestContext,
): Promise<void> {
  const { ToolProcessor } = await import("./utils/config/toolProcessor.js");

  ToolProcessor.registerChangeCallback(
    async (filePath, eventType, changeContext) => {
      const rebuildContext =
        changeContext ||
        requestContextService.createRequestContext({
          operation: "AutoReloadOnFileChange",
          filePath,
          eventType,
        });

      logger.info(
        rebuildContext,
        `YAML file changed (${eventType}): ${filePath} - rebuilding tools`,
      );

      try {
        // Create new processor for rebuild
        const newProcessor = new ToolProcessor();
        await newProcessor.initialize(rebuildContext);
        const result = await newProcessor.processTools(rebuildContext);

        if (result.success) {
          // Update cache with new configurations
          const toolConfigs = newProcessor.getToolConfigurations();
          const cacheResult = cachedToolConfigs!.cacheToolConfigs(
            toolConfigs,
            rebuildContext,
          );

          if (cacheResult.success) {
            logger.info(
              rebuildContext,
              `Tools rebuilt successfully: ${cacheResult.toolCount} tools, ${cacheResult.toolsetCount} toolsets`,
            );

            // Update global processor reference
            toolProcessor = newProcessor;

            // Call server replacement callback if available
            if (serverReplacementCallback) {
              serverReplacementCallback(server);
            }
          } else {
            logger.error(
              rebuildContext,
              `Failed to cache rebuilt tools: ${cacheResult.error}`,
            );
          }
        } else {
          logger.error(
            rebuildContext,
            `Failed to rebuild tools: ${result.error}`,
          );
        }
      } catch (error) {
        logger.error(
          rebuildContext,
          `Error during auto-reload: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  logger.info(context, "YAML auto-reload functionality enabled");
}
