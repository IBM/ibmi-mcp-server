/**
 * @fileoverview Toolset manager for YAML-based tools
 * Replaces the suite system with toolset-based organization
 *
 * @module src/utils/yaml/toolsetManager
 */

import {
  SqlToolsetConfig,
  SqlToolsConfig,
} from "@/ibmi-mcp-server/schemas/index.js";
import { ErrorHandler, logger } from "@/utils/internal/index.js";
import {
  requestContextService,
  RequestContext,
} from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import generateSql from "../../tools/generateSql.tool.js";

/**
 * Global tools that are automatically added to all toolsets
 * These tools are typically TypeScript-based tools that provide universal functionality
 */
export const GLOBAL_TOOLS = [
  generateSql.name, // SQL DDL generation tool - available to all toolsets
] as const;

/**
 * Toolset information for MCP tool metadata
 */
export interface ToolsetInfo {
  /** Tool name */
  toolName: string;
  /** Toolsets this tool belongs to */
  toolsets: string[];
  /** Toolset metadata for MCP */
  toolsetMetadata: Record<string, SqlToolsetConfig>;
}

/**
 * Toolset statistics
 */
export interface ToolsetStats {
  /** Total number of toolsets */
  totalToolsets: number;
  /** Total number of tools */
  totalTools: number;
  /** Tools that belong to multiple toolsets */
  multiToolsetTools: string[];
  /** Toolsets with their tool counts */
  toolsetCounts: Record<string, number>;
}

/**
 * Toolset manager for YAML-based tools
 * Manages toolset organization and metadata for MCP tools
 */
export class ToolsetManager {
  private static instance: ToolsetManager | undefined;
  private toolsetConfig: Record<string, SqlToolsetConfig> = {};
  private toolToToolsets: Map<string, string[]> = new Map();
  private toolsetToTools: Map<string, string[]> = new Map();

  /**
   * Get the singleton instance of the ToolsetManager
   */
  static getInstance(): ToolsetManager {
    if (!ToolsetManager.instance) {
      ToolsetManager.instance = new ToolsetManager();
    }
    return ToolsetManager.instance;
  }

  /**
   * Initialize the toolset manager with YAML configuration
   * @param config - YAML configuration with toolsets (can be enhanced with TypeScript tools)
   * @param context - Request context for logging
   */
  async initialize(
    config: SqlToolsConfig,
    context?: RequestContext,
  ): Promise<void> {
    const operationContext =
      context ||
      requestContextService.createRequestContext({
        operation: "InitializeToolsetManager",
      });

    return ErrorHandler.tryCatch(
      async () => {
        logger.info(
          {
            ...operationContext,
            toolsetCount: config.toolsets
              ? Object.keys(config.toolsets).length
              : 0,
            toolCount: Object.keys(config.tools || {}).length,
          },
          "Initializing toolset manager",
        );

        // Clear existing data
        this.toolsetConfig = {};
        this.toolToToolsets.clear();
        this.toolsetToTools.clear();

        // Log global tools that will be added to all toolsets
        logger.debug(
          {
            ...operationContext,
            globalTools: GLOBAL_TOOLS,
          },
          "Global tools will be automatically added to all toolsets",
        );

        // Process toolsets if they exist
        if (config.toolsets) {
          this.toolsetConfig = { ...config.toolsets };

          // Build toolset-to-tool mappings with global tools
          for (const [toolsetName, toolset] of Object.entries(
            config.toolsets,
          )) {
            // Combine toolset-specific tools with global tools
            const allToolsForToolset = [...toolset.tools, ...GLOBAL_TOOLS];
            this.toolsetToTools.set(toolsetName, allToolsForToolset);

            // Build tool-to-toolset mappings for both regular and global tools
            for (const toolName of allToolsForToolset) {
              if (!this.toolToToolsets.has(toolName)) {
                this.toolToToolsets.set(toolName, []);
              }
              this.toolToToolsets.get(toolName)!.push(toolsetName);
            }
          }
        }

        // Validate that all tools referenced in toolsets exist
        const allToolNames = [
          ...Object.keys(config.tools || {}), // Regular YAML tools
          ...GLOBAL_TOOLS, // Global tools (TypeScript-based)
        ];
        for (const [toolsetName, toolset] of Object.entries(
          this.toolsetConfig,
        )) {
          for (const toolName of toolset.tools) {
            if (!allToolNames.includes(toolName)) {
              throw new McpError(
                JsonRpcErrorCode.ValidationError,
                `Toolset '${toolsetName}' references unknown tool '${toolName}'. Available tools: ${allToolNames.join(", ")}`,
                { toolsetName, toolName, availableTools: allToolNames },
              );
            }
          }
        }

        logger.info(
          {
            ...operationContext,
            toolsetCount: Object.keys(this.toolsetConfig).length,
            toolCount: this.toolToToolsets.size,
          },
          "Toolset manager initialized successfully",
        );
      },
      {
        operation: "InitializeToolsetManager",
        context: operationContext,
        errorCode: JsonRpcErrorCode.InitializationFailed,
      },
    );
  }

  /**
   * Get toolset information for a specific tool
   * @param toolName - Name of the tool
   * @returns Toolset information for the tool
   */
  getToolsetInfo(toolName: string): ToolsetInfo {
    let toolsets = this.toolToToolsets.get(toolName) || [];

    // If this is a global tool but not in the mapping, add it to all toolsets
    if (
      (GLOBAL_TOOLS as readonly string[]).includes(toolName) &&
      toolsets.length === 0
    ) {
      toolsets = Object.keys(this.toolsetConfig);
    }

    const toolsetMetadata: Record<string, SqlToolsetConfig> = {};

    // Build toolset metadata for the tool
    for (const toolsetName of toolsets) {
      const toolset = this.toolsetConfig[toolsetName];
      if (toolset) {
        toolsetMetadata[toolsetName] = toolset;
      }
    }

    return {
      toolName,
      toolsets,
      toolsetMetadata,
    };
  }

  /**
   * Get all tools in a specific toolset
   * @param toolsetName - Name of the toolset
   * @returns Array of tool names in the toolset
   */
  getToolsInToolset(toolsetName: string): string[] {
    return this.toolsetToTools.get(toolsetName) || [];
  }

  /**
   * Get all toolset names
   * @returns Array of toolset names
   */
  getAllToolsetNames(): string[] {
    return Object.keys(this.toolsetConfig);
  }

  /**
   * Get toolset configuration
   * @param toolsetName - Name of the toolset
   * @returns Toolset configuration or undefined if not found
   */
  getToolsetConfig(toolsetName: string): SqlToolsetConfig | undefined {
    return this.toolsetConfig[toolsetName];
  }

  /**
   * Get statistics about toolsets
   * @returns Toolset statistics
   */
  getToolsetStats(): ToolsetStats {
    const multiToolsetTools: string[] = [];
    const toolsetCounts: Record<string, number> = {};

    // Find tools that belong to multiple toolsets
    for (const [toolName, toolsets] of this.toolToToolsets) {
      if (toolsets.length > 1) {
        multiToolsetTools.push(toolName);
      }
    }

    // Count tools per toolset
    for (const [toolsetName, tools] of this.toolsetToTools) {
      toolsetCounts[toolsetName] = tools.length;
    }

    return {
      totalToolsets: Object.keys(this.toolsetConfig).length,
      totalTools: this.toolToToolsets.size,
      multiToolsetTools,
      toolsetCounts,
    };
  }

  /**
   * Check if a tool belongs to a specific toolset
   * @param toolName - Name of the tool
   * @param toolsetName - Name of the toolset
   * @returns True if the tool belongs to the toolset
   */
  isToolInToolset(toolName: string, toolsetName: string): boolean {
    const toolsets = this.toolToToolsets.get(toolName) || [];
    return toolsets.includes(toolsetName);
  }

  /**
   * Get all tools with their toolset memberships
   * @returns Map of tool names to their toolset arrays
   */
  getAllToolToolsetMappings(): Map<string, string[]> {
    return new Map(this.toolToToolsets);
  }

  /**
   * Filter tools by toolset
   * @param toolsetName - Name of the toolset to filter by
   * @param allTools - Array of all tool names
   * @returns Array of tool names that belong to the toolset
   */
  filterToolsByToolset(toolsetName: string, allTools: string[]): string[] {
    const toolsInToolset = this.getToolsInToolset(toolsetName);
    return allTools.filter((toolName) => toolsInToolset.includes(toolName));
  }

  /**
   * Generate MCP tool metadata with toolset information
   * @param toolName - Name of the tool
   * @param additionalMetadata - Additional metadata to merge
   * @returns Metadata object suitable for MCP tool registration
   */
  generateToolMetadata(
    toolName: string,
    additionalMetadata: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const toolsetInfo = this.getToolsetInfo(toolName);

    return {
      ...additionalMetadata,
      toolsets: toolsetInfo.toolsets,
      toolsetMetadata: toolsetInfo.toolsetMetadata,
      toolsetCount: toolsetInfo.toolsets.length,
    };
  }

  /**
   * Clear all toolset data (for testing)
   */
  clearAll(): void {
    this.toolsetConfig = {};
    this.toolToToolsets.clear();
    this.toolsetToTools.clear();
  }

  /**
   * Get a summary of the toolset manager state
   * @returns Summary object with current state
   */
  getSummary(): {
    toolsetCount: number;
    toolCount: number;
    totalMappings: number;
    toolsWithMultipleToolsets: number;
  } {
    const stats = this.getToolsetStats();

    return {
      toolsetCount: stats.totalToolsets,
      toolCount: stats.totalTools,
      totalMappings: Array.from(this.toolToToolsets.values()).reduce(
        (sum, toolsets) => sum + toolsets.length,
        0,
      ),
      toolsWithMultipleToolsets: stats.multiToolsetTools.length,
    };
  }
}
