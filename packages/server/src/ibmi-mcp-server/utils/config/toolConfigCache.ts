/**
 * @fileoverview Tool Configuration Cache - Caches pre-processed YAML tool configurations for fast server registration
 * Separates expensive YAML parsing from fast server registration to improve connection performance
 *
 * @module src/ibmi-mcp-server/utils/yaml/toolConfigCache
 */

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import { logger, RequestContext } from "@/utils/internal/index.js";
import type { CachedToolConfig } from "./types.js";
import { createHandlerFromDefinition } from "./toolDefinitions.js";

/**
 * Tool Configuration Cache - Singleton class that manages cached tool configurations
 * Provides fast tool registration by pre-processing YAML configurations during startup
 */
export class ToolConfigCache {
  private static instance: ToolConfigCache | null = null;
  private cache: Map<string, CachedToolConfig> = new Map();

  /**
   * Get or create the singleton instance
   */
  static getInstance(): ToolConfigCache {
    if (!ToolConfigCache.instance) {
      ToolConfigCache.instance = new ToolConfigCache();
    }
    return ToolConfigCache.instance;
  }

  /**
   * Cache pre-built tool configurations
   * @param toolConfigs - Array of already-created tool configurations
   * @param context - Request context
   */
  cacheToolConfigs(
    toolConfigs: CachedToolConfig[],
    context?: RequestContext,
  ): {
    success: boolean;
    error?: string;
    toolCount: number;
    toolsetCount: number;
  } {
    const cacheContext = context
      ? {
          ...context,
          operation: "ToolConfigCache.cacheToolConfigs",
        }
      : { operation: "ToolConfigCache.cacheToolConfigs" };

    logger.info(
      cacheContext,
      `Caching ${toolConfigs.length} pre-built tool configurations`,
    );

    const cacheStart = Date.now();

    try {
      // Clear existing cache
      this.cache.clear();

      let cachedToolCount = 0;
      const toolsetNames = new Set<string>();

      for (const toolConfig of toolConfigs) {
        try {
          this.cache.set(toolConfig.name, toolConfig);
          cachedToolCount++;

          const annotationToolsets = Array.isArray(
            (toolConfig.annotations as { toolsets?: unknown }).toolsets,
          )
            ? ((toolConfig.annotations as { toolsets?: string[] }).toolsets ??
              [])
            : [];

          annotationToolsets.forEach((ts) => toolsetNames.add(ts));
        } catch (error) {
          logger.error(
            cacheContext,
            `Failed to cache tool ${toolConfig.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Continue with other tools
        }
      }

      const cacheDuration = Date.now() - cacheStart;

      logger.info(
        cacheContext,
        `Tool configurations cached successfully: ${cachedToolCount} tools, ${toolsetNames.size} toolsets in ${cacheDuration}ms`,
      );

      return {
        success: true,
        toolCount: cachedToolCount,
        toolsetCount: toolsetNames.size,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        cacheContext,
        `Failed to cache tool configurations: ${errorMessage}`,
      );

      return {
        success: false,
        error: errorMessage,
        toolCount: 0,
        toolsetCount: 0,
      };
    }
  }

  /**
   * Register all cached tools with an MCP server instance.
   * Runs once per HTTP request, so it only wires up what the cache holds.
   * @returns the registered tools
   */
  registerCachedTools(server: McpServer): RegisteredTool[] {
    const registered: RegisteredTool[] = [];

    for (const [toolName, config] of this.cache) {
      try {
        registered.push(
          server.registerTool(
            toolName,
            {
              title: config.title,
              description: config.description,
              inputSchema: config.inputSchema,
              outputSchema: config.outputSchema,
              annotations: config.annotations,
            },
            createHandlerFromDefinition(config),
          ),
        );
      } catch (error) {
        logger.error(
          { operation: "ToolConfigCache.registerCachedTools" },
          `Failed to register cached tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return registered;
  }
}
