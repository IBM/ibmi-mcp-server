import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import { config } from "@/config/index.js";
import { ToolProcessor } from "./utils/config/toolProcessor.js";
import { ToolConfigCache } from "./utils/config/toolConfigCache.js";
import { describeToolsetResources } from "./resources/toolsetsResource/index.js";
import {
  logger,
  requestContextService,
  RequestContext,
} from "@/utils/internal/index.js";

/** Called after a YAML reload replaced the cached tool set. */
type ReloadListener = (change: { resourcesChanged: boolean }) => void;

const toolCache = ToolConfigCache.getInstance();
const reloadListeners = new Set<ReloadListener>();

/**
 * Parses the YAML tool files and replaces the cached tool set.
 * Throws when the configuration cannot be loaded; the cache then keeps its
 * previous content.
 */
async function buildToolCache(context: RequestContext): Promise<void> {
  const processor = new ToolProcessor();
  await processor.initialize(context);
  await processor.processTools(context);

  const cacheResult = toolCache.cacheToolConfigs(
    processor.getToolConfigurations(),
    context,
  );
  if (!cacheResult.success) {
    throw new Error(`Tool caching failed: ${cacheResult.error}`);
  }
  logger.info(
    context,
    `YAML tools processed and cached: ${cacheResult.toolCount} tools, ${cacheResult.toolsetCount} toolsets`,
  );
}

/**
 * Loads the YAML tools once, at startup, and starts auto-reload when enabled.
 * Server instances are built per request from the cache this fills, so YAML
 * is never parsed on the request path.
 */
export const loadSQLTools = async (): Promise<void> => {
  if (!config.toolsYamlPath) {
    logger.debug(
      {},
      "No YAML tools configuration found, skipping YAML tools loading",
    );
    return;
  }

  const context = requestContextService.createRequestContext({
    operation: "loadSQLTools",
    yamlPath: config.toolsYamlPath,
  });
  logger.info(
    context,
    `Processing YAML tools from configuration: ${config.toolsYamlPath} (auto-reload: ${config.yamlAutoReload})`,
  );

  await buildToolCache(context);

  if (config.yamlAutoReload) {
    ToolProcessor.registerChangeCallback(reloadSQLTools);
    logger.info(context, "YAML auto-reload functionality enabled");
  }
};

/** Registers the cached YAML tools with a server instance. */
export const registerSQLTools = (server: McpServer): RegisteredTool[] =>
  toolCache.registerCachedTools(server);

/**
 * Subscribes to YAML reloads. Returns the unsubscribe function.
 */
export const onSQLToolsReloaded = (listener: ReloadListener): (() => void) => {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
};

async function reloadSQLTools(
  filePath: string,
  eventType: string,
  changeContext?: RequestContext,
): Promise<void> {
  const context =
    changeContext ||
    requestContextService.createRequestContext({
      operation: "AutoReloadOnFileChange",
      filePath,
      eventType,
    });
  logger.info(
    context,
    `YAML file changed (${eventType}): ${filePath} - rebuilding tools`,
  );

  try {
    const resourcesBefore = JSON.stringify(describeToolsetResources());
    await buildToolCache(context);
    const resourcesChanged =
      resourcesBefore !== JSON.stringify(describeToolsetResources());
    for (const listener of reloadListeners) {
      listener({ resourcesChanged });
    }
  } catch (error) {
    logger.error(
      context,
      `Error during auto-reload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
