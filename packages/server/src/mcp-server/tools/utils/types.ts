/**
 * Tool Factory Contracts
 *
 * TypeScript interfaces defining the contract between tool authors
 * and the registration system.
 *
 * @module tool-factory
 * @feature 001-tool-factory
 */

import type { z, ZodObject, ZodRawShape } from "zod";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestContext } from "../../../utils/index.js";

// =============================================================================
// Core Types
// =============================================================================

/**
 * Defines the function signature for formatting a successful tool logic result
 * into content blocks for display.
 * @template TOutput The type of the successful output from the logic.
 * @param result The successful output from the tool's logic function.
 * @returns An array of ContentBlocks for the MCP client to display.
 */
export type ResponseFormatter<TOutput> = (result: TOutput) => ContentBlock[];

/**
 * A type alias for the SDK's `RequestHandlerExtra` context, making it more
 * specific and easier to reference in our tool logic signatures.
 * Provides access to protocol-level capabilities like cancellation, notifications, and auth.
 */
export type SdkContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Function signature for tool business logic.
 * Receives validated input, application context, and SDK context, returns structured output.
 *
 * @template TInput - Input type inferred from inputSchema
 * @template TOutput - Output type inferred from outputSchema
 */
export type ToolLogicFn<TInput, TOutput> = (
  params: TInput,
  appContext: RequestContext,
  sdkContext: SdkContext,
) => Promise<TOutput>;

/**
 * MCP protocol hints for LLM decision-making.
 * All fields are optional and default to false.
 */
export interface ToolAnnotations {
  /** Tool only reads data, no side effects */
  readOnlyHint?: boolean;
  /** Tool may permanently delete or modify data */
  destructiveHint?: boolean;
  /** Tool makes external API or network calls */
  openWorldHint?: boolean;
}

// =============================================================================
// Tool Definition
// =============================================================================

/**
 * Developer-facing interface for declaring an MCP tool.
 *
 * @template TInputShape - Zod shape for input schema
 * @template TOutputShape - Zod shape for output schema
 *
 * @example
 * ```typescript
 * const myTool = defineTool({
 *   name: "my_tool",
 *   description: "Does something useful",
 *   inputSchema: z.object({ query: z.string() }),
 *   outputSchema: z.object({ result: z.string() }),
 *   logic: async ({ query }, appContext) => {
 *     logger.debug({ ...appContext, query }, 'Processing query');
 *     return { result: `Processed: ${query}` };
 *   },
 * });
 * ```
 */
export interface ToolDefinition<
  TInputShape extends ZodRawShape = ZodRawShape,
  TOutputShape extends ZodRawShape = ZodRawShape,
> {
  /**
   * Unique tool identifier.
   * Convention: snake_case (e.g., "describe_sql_object")
   */
  name: string;

  /**
   * LLM-facing description of tool capabilities.
   * Should clearly explain what the tool does and when to use it.
   */
  description: string;

  /**
   * Zod schema validating tool input.
   * Input is validated before logic function is called.
   */
  inputSchema: ZodObject<TInputShape>;

  /**
   * Zod schema defining expected output structure.
   * Used for documentation and type inference.
   */
  outputSchema: ZodObject<TOutputShape>;

  /**
   * Pure async function implementing tool behavior.
   * Receives validated input and application context, returns structured output.
   */
  logic: ToolLogicFn<
    z.infer<ZodObject<TInputShape>>,
    z.infer<ZodObject<TOutputShape>>
  >;

  /**
   * Human-readable title for UI display.
   * Defaults to formatted tool name if not provided.
   */
  title?: string;

  /**
   * Custom output formatter.
   * Defaults to JSON serialization with text summary.
   */
  responseFormatter?: ResponseFormatter<z.infer<ZodObject<TOutputShape>>>;

  /**
   * MCP safety hints for LLM decision-making.
   * All hints default to false if not specified.
   */
  annotations?: ToolAnnotations;

  /**
   * Conditional registration control.
   * Set to false or return false from function to skip registration.
   * Defaults to true (tool is registered).
   */
  enabled?: boolean | (() => boolean);
}
