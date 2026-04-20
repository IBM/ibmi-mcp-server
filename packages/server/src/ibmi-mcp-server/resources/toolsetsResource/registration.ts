/**
 * @fileoverview Handles the registration of the `toolsets` resource with an MCP server instance.
 * This module acts as the "handler" layer, connecting the pure business logic to the
 * MCP server and ensuring all outcomes (success or failure) are handled gracefully.
 * @module src/mcp-server/resources/toolsetsResource/registration
 * @see {@link src/mcp-server/resources/toolsetsResource/logic.ts} for the core business logic and schemas.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { JsonRpcErrorCode } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import { toolsetsResourceLogic } from "./logic.js";
import { ToolsetManager } from "../../utils/config/toolsetManager.js";

/**
 * Registers the 'toolsets' resource and its handlers with the provided MCP server instance.
 * This resource exposes all available toolsets on the server with their metadata and tool listings.
 *
 * @param server - The MCP server instance to register the resource with.
 */
export const registerToolsetsResource = async (
  server: McpServer,
): Promise<void> => {
  const resourceName = "toolsets-resource";
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterResource",
      resourceName: resourceName,
    });

  logger.info(registrationContext, `Registering resource: '${resourceName}'`);

  await ErrorHandler.tryCatch(
    async () => {
      // Register the main "all toolsets" resource
      server.registerResource(
        `${resourceName}-all`,
        "toolsets://",
        {
          description:
            "Complete catalog of all available toolsets and their tools",
          mimeType: "application/json",
        },
        async (
          uri: URL,
          callContext: Record<string, unknown>,
        ): Promise<ReadResourceResult> => {
          const sessionId =
            typeof callContext?.sessionId === "string"
              ? callContext.sessionId
              : undefined;

          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: callContext,
              operation: "HandleResourceRead",
              resourceUri: uri.href,
              sessionId,
            });

          try {
            const result = await toolsetsResourceLogic(uri, {}, handlerContext);

            return {
              contents: [
                {
                  uri: uri.href,
                  blob: Buffer.from(JSON.stringify(result, null, 2)).toString(
                    "base64",
                  ),
                  mimeType: "application/json",
                },
              ],
            };
          } catch (error) {
            throw ErrorHandler.handleError(error, {
              operation: "toolsetsAllResourceReadHandler",
              context: handlerContext,
              input: { uri: uri.href },
            });
          }
        },
      );

      // Register individual toolset resources
      const toolsetManager = ToolsetManager.getInstance();
      const allToolsetNames = toolsetManager.getAllToolsetNames();

      for (const toolsetName of allToolsetNames) {
        const toolsetConfig = toolsetManager.getToolsetConfig(toolsetName);
        const toolsInToolset = toolsetManager.getToolsInToolset(toolsetName);

        server.registerResource(
          `${resourceName}-${toolsetName}`,
          `toolsets://${toolsetName}`,
          {
            description: toolsetConfig?.description
              ? `${toolsetConfig.description} (${toolsInToolset.length} tools)`
              : `${toolsetName} toolset with ${toolsInToolset.length} tools`,
            mimeType: "application/json",
          },
          async (
            uri: URL,
            callContext: Record<string, unknown>,
          ): Promise<ReadResourceResult> => {
            const sessionId =
              typeof callContext?.sessionId === "string"
                ? callContext.sessionId
                : undefined;

            const handlerContext: RequestContext =
              requestContextService.createRequestContext({
                parentContext: callContext,
                operation: "HandleResourceRead",
                resourceUri: uri.href,
                sessionId,
              });

            try {
              const result = await toolsetsResourceLogic(
                uri,
                { toolsetName },
                handlerContext,
              );

              return {
                contents: [
                  {
                    uri: uri.href,
                    blob: Buffer.from(JSON.stringify(result, null, 2)).toString(
                      "base64",
                    ),
                    mimeType: "application/json",
                  },
                ],
              };
            } catch (error) {
              throw ErrorHandler.handleError(error, {
                operation: `toolsetsResourceReadHandler_${toolsetName}`,
                context: handlerContext,
                input: { uri: uri.href, toolsetName },
              });
            }
          },
        );
      }

      logger.info(
        registrationContext,
        `Resource '${resourceName}' registered successfully.`,
      );
    },
    {
      operation: `RegisteringResource_${resourceName}`,
      context: registrationContext,
      errorCode: JsonRpcErrorCode.InitializationFailed,
      critical: true,
    },
  );
};
