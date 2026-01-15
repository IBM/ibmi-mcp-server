/**
 * Tool Registration Factory
 *
 * Provides a factory pattern for creating and registering MCP tools with minimal boilerplate.
 * Handles validation, registration, error handling, and response formatting automatically.
 *
 * @module tool-factory
 * @feature 001-tool-factory
 */

import { z, ZodObject } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import { JsonRpcErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  requestContextService,
  measureToolExecution,
  type RequestContext,
} from "../../../utils/index.js";
import {
  logOperationStart,
  logOperationSuccess,
} from "../../../utils/internal/logging-helpers.js";
import type {
  ToolDefinition,
  ToolAnnotations,
  ResponseFormatter,
  SdkContext,
} from "./types.js";

// =============================================================================
// Validation Schema
// =============================================================================

/**
 * Zod schema for validating tool definitions at registration time.
 */
export const ToolDefinitionSchema = z.object({
  name: z
    .string()
    .min(1, "Tool name is required")
    .regex(
      /^[a-z][a-z0-9_]*$/,
      "Tool name must be snake_case (lowercase letters, numbers, underscores)",
    ),
  description: z.string().min(1, "Tool description is required"),
  inputSchema: z.custom<ZodObject<z.ZodRawShape>>(
    (val) => val instanceof z.ZodObject,
    {
      message: "inputSchema must be a Zod object schema",
    },
  ),
  outputSchema: z.custom<ZodObject<z.ZodRawShape>>(
    (val) => val instanceof z.ZodObject,
    {
      message: "outputSchema must be a Zod object schema",
    },
  ),
  logic: z.function(),
  title: z.string().optional(),
  responseFormatter: z.function().optional(),
  annotations: z
    .object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
  enabled: z.union([z.boolean(), z.function()]).optional(),
});

// =============================================================================
// Default Response Formatter
// =============================================================================

/**
 * Default formatter for successful responses.
 * Returns a simple JSON representation of the result.
 */
const defaultResponseFormatter = (result: unknown): ContentBlock[] => [
  { type: "text", text: JSON.stringify(result, null, 2) },
];

// =============================================================================
// Handler Factory
// =============================================================================

/**
 * Creates a standardized MCP tool handler.
 * This factory encapsulates context creation, performance measurement,
 * error handling, and response formatting. It separates the app's internal
 * RequestContext from the SDK's context (SdkContext).
 *
 * @param toolName - The name of the tool for logging and metrics
 * @param logic - The core business logic function
 * @param responseFormatter - Optional custom formatter (defaults to JSON)
 * @returns A handler function compatible with the MCP SDK's tool callback
 */
export function createHandler<TInput, TOutput>(
  toolName: string,
  logic: (
    input: TInput,
    appContext: RequestContext,
    sdkContext: SdkContext,
  ) => Promise<TOutput>,
  responseFormatter: ResponseFormatter<TOutput> = defaultResponseFormatter as ResponseFormatter<TOutput>,
): (input: TInput, extra: unknown) => Promise<CallToolResult> {
  return async (
    input: TInput,
    callContext: unknown,
  ): Promise<CallToolResult> => {
    // Cast the SDK context to our specific SdkContext type
    const sdkContext = callContext as SdkContext;

    const sessionId =
      typeof sdkContext?.sessionId === "string"
        ? sdkContext.sessionId
        : undefined;

    // Create the application's internal logger/tracing context
    const appContext = requestContextService.createRequestContext({
      parentContext: sdkContext,
      operation: "HandleToolRequest",
      additionalContext: { toolName, sessionId, input },
    });

    try {
      const result = await measureToolExecution(
        toolName,
        () => logic(input, appContext, sdkContext),
        input,
      );

      return {
        structuredContent: result as Record<string, unknown>,
        content: responseFormatter(result),
      };
    } catch (error: unknown) {
      const mcpError = ErrorHandler.handleError(error, {
        operation: `tool:${toolName}`,
        context: appContext,
        input,
      }) as McpError;

      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${mcpError.message}` }],
        structuredContent: {
          code: mcpError.code,
          message: mcpError.message,
          details: mcpError.details,
        },
      };
    }
  };
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Factory function for creating tool definitions.
 * Provides type inference and acts as the main entry point for tool authors.
 *
 * @param definition - The tool configuration
 * @returns The same tool definition (for type inference)
 */
export function defineTool<
  TInputShape extends z.ZodRawShape,
  TOutputShape extends z.ZodRawShape,
>(
  definition: ToolDefinition<TInputShape, TOutputShape>,
): ToolDefinition<TInputShape, TOutputShape> {
  // Validate the definition
  ToolDefinitionSchema.parse(definition);
  return definition;
}

/**
 * Registers a single tool from its definition.
 * Accepts any tool definition shape to support arrays of mixed tool types.
 *
 * @param server - The MCP server instance
 * @param toolDef - The tool definition to register
 */
export async function registerToolFromDefinition(
  server: McpServer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolDef: ToolDefinition<any, any>,
): Promise<void> {
  const registrationContext = requestContextService.createRequestContext({
    operation: "RegisterTool",
    toolName: toolDef.name,
  });

  logOperationStart(registrationContext, `Registering tool: '${toolDef.name}'`);

  await ErrorHandler.tryCatch(
    async () => {
      // Check if tool is enabled
      const enabled =
        toolDef.enabled === undefined
          ? true
          : typeof toolDef.enabled === "function"
            ? toolDef.enabled()
            : toolDef.enabled;

      if (!enabled) {
        logOperationSuccess(
          registrationContext,
          `Tool '${toolDef.name}' is disabled, skipping registration`,
        );
        return;
      }

      // Prepare metadata
      const title =
        toolDef.title ||
        toolDef.name
          .split("_")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");

      const annotations: Required<ToolAnnotations> = {
        readOnlyHint: toolDef.annotations?.readOnlyHint ?? false,
        destructiveHint: toolDef.annotations?.destructiveHint ?? false,
        openWorldHint: toolDef.annotations?.openWorldHint ?? false,
      };

      // Use custom formatter or default
      const responseFormatter =
        toolDef.responseFormatter || defaultResponseFormatter;

      // Create handler using the factory
      const handler = createHandler(
        toolDef.name,
        toolDef.logic,
        responseFormatter,
      );

      // Register with MCP server
      // Use .shape to extract raw schema like YAML tools do
      server.registerTool(
        toolDef.name,
        {
          title,
          description: toolDef.description,
          inputSchema: toolDef.inputSchema.shape,
          outputSchema: toolDef.outputSchema.shape,
          annotations,
        },
        handler,
      );

      logOperationSuccess(
        registrationContext,
        `Tool '${toolDef.name}' registered successfully`,
      );
    },
    {
      operation: `RegisteringTool_${toolDef.name}`,
      context: registrationContext,
      errorCode: JsonRpcErrorCode.InitializationFailed,
      critical: true,
    },
  );
}
