/**
 * @fileoverview Handles the registration of the `toolsets` resources with an MCP server instance.
 * This module acts as the "handler" layer, connecting the pure business logic to the
 * MCP server and ensuring all outcomes (success or failure) are handled gracefully.
 * @module src/mcp-server/resources/toolsetsResource/registration
 * @see {@link src/mcp-server/resources/toolsetsResource/logic.ts} for the core business logic and schemas.
 */

import type {
  McpServer,
  ReadResourceResult,
  RegisteredResource,
} from "@modelcontextprotocol/server";
import { ErrorHandler, requestContextService } from "../../../utils/index.js";
import { toolsetsResourceLogic } from "./logic.js";
import { ToolsetManager } from "../../utils/config/toolsetManager.js";

const RESOURCE_NAME = "toolsets-resource";

async function readToolsets(
  uri: URL,
  toolsetName?: string,
): Promise<ReadResourceResult> {
  const context = requestContextService.createRequestContext({
    operation: "HandleResourceRead",
    resourceUri: uri.href,
  });

  try {
    const result = await toolsetsResourceLogic(
      uri,
      toolsetName ? { toolsetName } : {},
      context,
    );

    return {
      contents: [
        {
          uri: uri.href,
          blob: Buffer.from(JSON.stringify(result, null, 2)).toString("base64"),
          mimeType: "application/json",
        },
      ],
    };
  } catch (error) {
    throw ErrorHandler.handleError(error, {
      operation: "toolsetsResourceReadHandler",
      context,
      input: { uri: uri.href, toolsetName },
    });
  }
}

/**
 * Registers the `toolsets://` catalog resource, which lists every toolset.
 */
export const registerToolsetsResource = (server: McpServer): void => {
  server.registerResource(
    `${RESOURCE_NAME}-all`,
    "toolsets://",
    {
      description: "Complete catalog of all available toolsets and their tools",
      mimeType: "application/json",
    },
    (uri) => readToolsets(uri),
  );
};

/**
 * Describes the per-toolset resources for the YAML configuration currently
 * loaded. Comparing two snapshots tells whether a reload changed the list.
 */
export const describeToolsetResources = (): Array<{
  toolsetName: string;
  description: string;
}> => {
  const toolsetManager = ToolsetManager.getInstance();
  return toolsetManager.getAllToolsetNames().map((toolsetName) => {
    const description =
      toolsetManager.getToolsetConfig(toolsetName)?.description;
    const toolCount = toolsetManager.getToolsInToolset(toolsetName).length;
    return {
      toolsetName,
      description: description
        ? `${description} (${toolCount} tools)`
        : `${toolsetName} toolset with ${toolCount} tools`,
    };
  });
};

/**
 * Registers one `toolsets://<name>` resource per toolset. Must run after the
 * YAML tools are loaded, which is what fills the ToolsetManager.
 */
export const registerPerToolsetResources = (
  server: McpServer,
): RegisteredResource[] =>
  describeToolsetResources().map(({ toolsetName, description }) =>
    server.registerResource(
      `${RESOURCE_NAME}-${toolsetName}`,
      `toolsets://${toolsetName}`,
      { description, mimeType: "application/json" },
      (uri) => readToolsets(uri, toolsetName),
    ),
  );
