/**
 * @fileoverview Tool Configuration Cache - Caches pre-processed YAML tool configurations for fast server registration
 * Separates expensive YAML parsing from fast server registration to improve connection performance
 *
 * @module src/ibmi-mcp-server/utils/yaml/toolConfigCache
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger, RequestContext } from "@/utils/internal/index.js";
import { CachedToolConfig } from "./types.js";
import { createHandlerFromDefinition } from "./toolDefinitions.js";

/**
 * Statistics about the cached tools
 */
export interface ToolCacheStats {
  /** Number of cached tools */
  toolCount: number;
  /** Number of toolsets */
  toolsetCount: number;
  /** Last cache build timestamp */
  lastBuilt?: Date;
  /** Cache build duration in milliseconds */
  buildDurationMs?: number;
  /** Whether cache is currently being rebuilt */
  isRebuilding: boolean;
}

/**
 * Tool Configuration Cache - Singleton class that manages cached tool configurations
 * Provides fast tool registration by pre-processing YAML configurations during startup
 */
export class ToolConfigCache {
  private static instance: ToolConfigCache | null = null;
  private cache: Map<string, CachedToolConfig> = new Map();
  private stats: ToolCacheStats = {
    toolCount: 0,
    toolsetCount: 0,
    isRebuilding: false,
  };

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
    this.stats.isRebuilding = true;

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

      // Update stats
      const cacheDuration = Date.now() - cacheStart;
      this.stats = {
        toolCount: cachedToolCount,
        toolsetCount: toolsetNames.size,
        lastBuilt: new Date(),
        buildDurationMs: cacheDuration,
        isRebuilding: false,
      };

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
      this.stats.isRebuilding = false;
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
   * Register all cached tools with an MCP server
   * This is extremely fast since all preprocessing is done
   */
  async registerCachedTools(
    server: McpServer,
    context: RequestContext,
  ): Promise<void> {
    const registrationContext = {
      ...context,
      operation: "ToolConfigCache.registerCachedTools",
    };

    if (this.cache.size === 0) {
      logger.warning(
        registrationContext,
        "No cached tools available for registration",
      );
      return;
    }

    logger.info(
      registrationContext,
      `Registering ${this.cache.size} cached tools`,
    );

    const registrationStart = Date.now();
    let registeredCount = 0;

    for (const [toolName, config] of this.cache) {
      try {
        const handler = createHandlerFromDefinition(config);

        server.registerTool(
          toolName,
          {
            title: config.title,
            description: config.description,
            inputSchema: config.inputSchema.shape,
            outputSchema: config.outputSchema.shape,
            annotations: config.annotations,
          },
          handler,
        );
        registeredCount++;
      } catch (error) {
        logger.error(
          registrationContext,
          `Failed to register cached tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const registrationDuration = Date.now() - registrationStart;
    logger.info(
      registrationContext,
      `Registered ${registeredCount} cached tools in ${registrationDuration}ms`,
    );
  }

  /**
   * Get cache statistics
   */
  getStats(): ToolCacheStats {
    return { ...this.stats };
  }

  /**
   * Get all cached tool names
   */
  getCachedToolNames(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Check if cache has any tools
   */
  isEmpty(): boolean {
    return this.cache.size === 0;
  }

  /**
   * Clear the cache (for testing)
   */
  clear(): void {
    this.cache.clear();
    this.stats = {
      toolCount: 0,
      toolsetCount: 0,
      isRebuilding: false,
    };
  }
}
export { CachedToolConfig };
