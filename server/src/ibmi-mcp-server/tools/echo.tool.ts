/**
 * Echo Tool
 *
 * Simple test tool to verify factory pattern and schema validation.
 *
 * @module echo.tool
 * @feature 001-tool-factory
 */

import { z } from "zod";
import { defineTool } from "../../mcp-server/tools/utils/tool-factory.js";
import type { SdkContext } from "../../mcp-server/tools/utils/types.js";
import type { RequestContext } from "../../utils/index.js";
import { logger } from "../../utils/internal/logger.js";

// =============================================================================
// Schemas
// =============================================================================

/**
 * Input schema for echo tool
 */
const EchoInputSchema = z.object({
  message: z
    .string()
    .min(1, "Message cannot be empty.")
    .max(1000, "Message cannot exceed 1000 characters.")
    .describe("The message to echo back."),
});

/**
 * Output schema for echo tool
 */
const EchoOutputSchema = z.object({
  echoed: z.string().describe("The echoed message."),
  length: z.number().describe("Length of the message."),
  timestamp: z.string().describe("ISO timestamp when echoed."),
});

type EchoInput = z.infer<typeof EchoInputSchema>;
type EchoOutput = z.infer<typeof EchoOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

/**
 * Core logic for echo tool
 */
async function echoLogic(
  params: EchoInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<EchoOutput> {
  logger.debug(
    { ...appContext, message: params.message },
    "Processing echo request",
  );

  return {
    echoed: params.message,
    length: params.message.length,
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// Tool Definition
// =============================================================================

export const echoTool = defineTool({
  name: "echo_test",
  title: "Echo Test",
  description:
    "Simple test tool that echoes back the input message with metadata.",
  inputSchema: EchoInputSchema,
  outputSchema: EchoOutputSchema,
  logic: echoLogic,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
});
