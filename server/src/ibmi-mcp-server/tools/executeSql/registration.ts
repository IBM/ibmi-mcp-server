/**
 * @fileoverview Handles registration and error handling for the `execute_sql` tool.
 * This module acts as the "handler" layer, connecting the pure business logic to the
 * MCP server and ensuring all outcomes (success or failure) are handled gracefully.
 * @module src/mcp-server/tools/executeSql/registration
 * @see {@link src/mcp-server/tools/executeSql/logic.ts} for the core business logic and schemas.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JsonRpcErrorCode } from "../../../types-global/errors.js";
import { ErrorHandler, requestContextService } from "../../../utils/index.js";
import {
  logOperationStart,
  logOperationSuccess,
} from "../../../utils/internal/logging-helpers.js";
import { ResponseFormatter } from "../../../mcp-server/tools/utils/tool-utils.js";
import { measureToolExecution } from "../../../utils/internal/performance.js";
import { getRequestContext } from "../../../utils/internal/asyncContext.js";
import {
  ExecuteSqlInput,
  ExecuteSqlInputSchema,
  executeSqlLogic,
  ExecuteSqlResponse,
  ExecuteSqlResponseSchema,
} from "./logic.js";

// The unique name for the tool, used for registration and identification.
const TOOL_NAME = "execute_sql";

// A concise description for the LLM. More detailed guidance should be in the
// parameter descriptions within the Zod schema in `logic.ts`.
const TOOL_DESCRIPTION = `Execute SQL statements against the IBM i database. Only SELECT and read-only operations are allowed for security.`;

const responseFormatter: ResponseFormatter<ExecuteSqlResponse> = (result) => ({
  structuredContent: result,
  content: [
    {
      type: "text",
      text: `SQL Query executed successfully. Returned ${result.rowCount} rows.\n\n${JSON.stringify(result.data, null, 2)}`,
    },
  ],
});

/**
 * Configuration interface for the execute SQL tool
 * This allows the tool to be enabled/disabled and configured via YAML
 */
export interface ExecuteSqlToolConfig {
  /** Whether the tool is enabled */
  enabled: boolean;
  /** Tool description override */
  description?: string;
  /** Security configuration */
  security?: {
    /** Whether to enforce read-only mode (default: true) */
    readOnly?: boolean;
    /** Maximum query length (default: 10000) */
    maxQueryLength?: number;
    /** Additional forbidden keywords */
    forbiddenKeywords?: string[];
  };
}

/**
 * Default configuration for the execute SQL tool
 */
const DEFAULT_CONFIG: ExecuteSqlToolConfig = {
  enabled: true,
  security: {
    readOnly: true,
    maxQueryLength: 10000,
    forbiddenKeywords: [],
  },
};

/**
 * Internal configuration storage
 */
let toolConfig: ExecuteSqlToolConfig = DEFAULT_CONFIG;

/**
 * Set the configuration for the execute SQL tool
 * This is called by the YAML configuration system
 * @param config - Tool configuration
 */
export function setExecuteSqlConfig(
  config: Partial<ExecuteSqlToolConfig>,
): void {
  toolConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    security: {
      ...DEFAULT_CONFIG.security,
      ...config.security,
    },
  };

  const context = requestContextService.createRequestContext({
    operation: "ConfigUpdate",
    toolName: TOOL_NAME,
  });

  logOperationSuccess(context, "Execute SQL tool configuration updated", {
    enabled: toolConfig.enabled,
    readOnly: toolConfig.security?.readOnly,
    maxQueryLength: toolConfig.security?.maxQueryLength,
  });
}

/**
 * Get the current configuration for the execute SQL tool
 * @returns Current tool configuration
 */
export function getExecuteSqlConfig(): ExecuteSqlToolConfig {
  return toolConfig;
}

/**
 * Check if the execute SQL tool is enabled
 * @returns True if the tool is enabled
 */
export function isExecuteSqlEnabled(): boolean {
  return toolConfig.enabled;
}

/**
 * Registers the 'execute_sql' tool and its handler with the provided MCP server instance.
 * This function uses ErrorHandler.tryCatch to ensure that any failure during the
 * registration process itself is caught and logged, preventing server startup failures.
 *
 * @param server - The MCP server instance to register the tool with.
 */
export const registerExecuteSqlTool = async (
  server: McpServer,
): Promise<void> => {
  const registrationContext = requestContextService.createRequestContext({
    operation: "RegisterTool",
    toolName: TOOL_NAME,
  });

  logOperationStart(
    registrationContext,
    `Checking if tool should be registered: '${TOOL_NAME}'`,
    {
      enabled: toolConfig.enabled,
    },
  );

  // Only register if the tool is enabled
  if (!toolConfig.enabled) {
    logOperationSuccess(
      registrationContext,
      `Tool '${TOOL_NAME}' is disabled, skipping registration`,
    );
    return;
  }

  logOperationStart(registrationContext, `Registering tool: '${TOOL_NAME}'`);

  await ErrorHandler.tryCatch(
    async () => {
      const description = toolConfig.description || TOOL_DESCRIPTION;

      server.registerTool(
        TOOL_NAME,
        {
          title: "Execute SQL",
          description,
          inputSchema: ExecuteSqlInputSchema.shape,
          outputSchema: ExecuteSqlResponseSchema.shape,
          annotations: {
            readOnlyHint: toolConfig.security?.readOnly, // Default to true for safety
            destructiveHint: !(toolConfig.security?.readOnly ?? true), // Destructive if not read-only
            openWorldHint: !(toolConfig.security?.readOnly ?? true), // Open world if not read-only
          },
          _meta: {
            requiresAuth: true, // Requires database authentication
          },
        },
        async (params: unknown, mcpContext: Record<string, unknown>) => {
          try {
            const result = await measureToolExecution(
              TOOL_NAME,
              () => executeSqlLogic(params as ExecuteSqlInput),
              params,
            );
            return responseFormatter(result);
          } catch (error) {
            const handlerContext = requestContextService.createRequestContext({
              parentContext: mcpContext,
              operation: `tool:${TOOL_NAME}`,
            });
            const handledError = ErrorHandler.handleError(error, {
              operation: `tool:${TOOL_NAME}`,
              context: getRequestContext() ?? handlerContext,
              input: params,
            });
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `SQL Error: ${(handledError as Error).message}`,
                },
              ],
              structuredContent: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                code: (handledError as any).code,
                message: (handledError as Error).message,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                details: (handledError as any).details,
              },
            };
          }
        },
      );

      logOperationSuccess(
        registrationContext,
        `Tool '${TOOL_NAME}' registered successfully.`,
        {
          enabled: toolConfig.enabled,
          readOnly: toolConfig.security?.readOnly,
        },
      );
    },
    {
      operation: `RegisteringTool_${TOOL_NAME}`,
      context: registrationContext,
      errorCode: JsonRpcErrorCode.InitializationFailed,
      critical: true, // A failure to register a tool is a critical startup error.
    },
  );
};
