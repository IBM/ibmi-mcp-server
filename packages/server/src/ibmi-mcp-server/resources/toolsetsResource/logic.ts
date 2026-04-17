/**
 * @fileoverview Defines the core logic, schemas, and types for the `toolsets` resource.
 * This module provides access to all available toolsets on the server, including
 * their metadata, tool counts, and organization details.
 * @module src/mcp-server/resources/toolsetsResource/logic
 * @see {@link src/mcp-server/resources/toolsetsResource/registration.ts} for the handler and registration logic.
 */

import { z } from "zod";
import { JsonRpcErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";
import { ToolsetManager } from "../../utils/config/toolsetManager.js";

// Zod schema for individual toolset information
export const ToolsetInfoSchema = z.object({
  name: z.string().describe("The name of the toolset"),
  description: z.string().describe("A description of the toolset's purpose"),
  tools: z.array(z.string()).describe("Array of tool names in this toolset"),
  toolCount: z
    .number()
    .int()
    .min(0)
    .describe("Number of tools in this toolset"),
});

// Zod schema for toolsets resource parameters
export const ToolsetsResourceParamsSchema = z.object({
  toolsetName: z
    .string()
    .optional()
    .describe("Optional toolset name to filter results"),
});

// Zod schema for the complete toolsets resource response
export const ToolsetsResourceResponseSchema = z.object({
  totalToolsets: z
    .number()
    .int()
    .min(0)
    .describe("Total number of toolsets available"),
  totalTools: z
    .number()
    .int()
    .min(0)
    .describe("Total number of tools across all toolsets"),
  toolsets: z
    .array(ToolsetInfoSchema)
    .describe("Array of toolset information objects"),
  statistics: z
    .object({
      multiToolsetTools: z
        .array(z.string())
        .describe("Tools that belong to multiple toolsets"),
      toolsetCounts: z
        .record(z.number().int().min(0))
        .describe("Map of toolset names to their tool counts"),
    })
    .describe("Additional statistics about toolset organization"),
  timestamp: z
    .string()
    .datetime()
    .describe("ISO 8601 timestamp when the data was retrieved"),
});

// Inferred TypeScript types
export type ToolsetsResourceParams = z.infer<
  typeof ToolsetsResourceParamsSchema
>;
export type ToolsetInfo = z.infer<typeof ToolsetInfoSchema>;
export type ToolsetsResourceResponse = z.infer<
  typeof ToolsetsResourceResponseSchema
>;

/**
 * Processes the core logic for the `toolsets` resource.
 * Retrieves toolset information from the ToolsetManager and formats it for MCP clients.
 *
 * @param uri - The resource URI, which may contain a specific toolset name
 * @param params - The validated resource parameters
 * @param context - The request context for logging and tracing
 * @returns A promise resolving with the structured toolsets data
 * @throws {McpError} If the toolset system is not initialized or toolset not found
 */
export async function toolsetsResourceLogic(
  uri: URL,
  params: ToolsetsResourceParams,
  context: RequestContext,
): Promise<ToolsetsResourceResponse> {
  logger.debug(
    {
      ...context,
      uri: uri.href,
      params,
    },
    "Processing toolsets resource logic",
  );

  const toolsetManager = ToolsetManager.getInstance();

  // Get toolset statistics
  const stats = toolsetManager.getToolsetStats();

  if (stats.totalToolsets === 0) {
    throw new McpError(
      JsonRpcErrorCode.InitializationFailed,
      "No toolsets are currently available. The toolset system may not be initialized.",
      { totalToolsets: stats.totalToolsets },
    );
  }

  // Extract toolset name from URI path if provided
  const pathSegments = uri.pathname.split("/").filter(Boolean);
  const toolsetNameFromUri =
    pathSegments.length > 0 ? pathSegments[0] : undefined;
  const requestedToolset = params.toolsetName || toolsetNameFromUri;

  let toolsetsToProcess: string[] = [];

  if (requestedToolset) {
    // Filter for specific toolset
    const toolsetConfig = toolsetManager.getToolsetConfig(requestedToolset);
    if (!toolsetConfig) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Toolset '${requestedToolset}' not found`,
        {
          requestedToolset,
          availableToolsets: toolsetManager.getAllToolsetNames(),
        },
      );
    }
    toolsetsToProcess = [requestedToolset];
    logger.debug(
      context,
      `Filtering for specific toolset: ${requestedToolset}`,
    );
  } else {
    // Get all toolsets
    toolsetsToProcess = toolsetManager.getAllToolsetNames();
    logger.debug(
      context,
      `Processing all ${toolsetsToProcess.length} toolsets`,
    );
  }

  // Build toolset information array
  const toolsets: ToolsetInfo[] = [];

  for (const toolsetName of toolsetsToProcess) {
    const toolsetConfig = toolsetManager.getToolsetConfig(toolsetName);
    if (!toolsetConfig) {
      logger.warning(
        context,
        `Skipping missing toolset configuration: ${toolsetName}`,
      );
      continue;
    }

    const toolsInToolset = toolsetManager.getToolsInToolset(toolsetName);

    const toolsetInfo: ToolsetInfo = {
      name: toolsetName,
      description: toolsetConfig.description || `Tools for ${toolsetName}`,
      tools: toolsInToolset,
      toolCount: toolsInToolset.length,
    };

    toolsets.push(toolsetInfo);
  }

  // Sort toolsets by name for consistent ordering
  toolsets.sort((a, b) => a.name.localeCompare(b.name));

  const response: ToolsetsResourceResponse = {
    totalToolsets: requestedToolset ? toolsets.length : stats.totalToolsets,
    totalTools: requestedToolset
      ? toolsets.reduce((sum, ts) => sum + ts.toolCount, 0)
      : stats.totalTools,
    toolsets,
    statistics: {
      multiToolsetTools: stats.multiToolsetTools,
      toolsetCounts: stats.toolsetCounts,
    },
    timestamp: new Date().toISOString(),
  };

  logger.debug(
    {
      ...context,
      responseSummary: {
        toolsetsReturned: toolsets.length,
        totalToolsInResponse: toolsets.reduce(
          (sum, ts) => sum + ts.toolCount,
          0,
        ),
        filteredByToolset: !!requestedToolset,
      },
    },
    "Toolsets resource processed successfully",
  );

  return response;
}
