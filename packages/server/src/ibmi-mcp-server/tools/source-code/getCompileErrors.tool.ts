/**
 * Get Compile Errors Tool
 *
 * Retrieves compilation error messages from the current job log.
 * Parses and formats error messages for AI analysis and fixing.
 *
 * @module getCompileErrors.tool
 */

import { z } from "zod";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { JsonRpcErrorCode, McpError } from "../../../types-global/errors.js";
import type { RequestContext } from "../../../utils/index.js";
import { logger } from "../../../utils/internal/logger.js";
import { IBMiConnectionPool } from "../../services/connectionPool.js";
import { defineTool } from "../../../mcp-server/tools/utils/tool-factory.js";
import type { SdkContext } from "../../../mcp-server/tools/utils/types.js";

// =============================================================================
// Schemas
// =============================================================================

const GetCompileErrorsInputSchema = z.object({
  min_severity: z
    .number()
    .optional()
    .default(20)
    .describe("Minimum message severity (0-99). Use 30+ for errors, 20+ for warnings"),
  max_messages: z
    .number()
    .optional()
    .default(100)
    .describe("Maximum number of messages to return"),
  message_type_filter: z
    .array(z.string())
    .optional()
    .describe("Filter by message types (e.g., ['DIAGNOSTIC', 'ESCAPE'])"),
});

const GetCompileErrorsOutputSchema = z.object({
  success: z.boolean().describe("Whether the query succeeded."),
  messageCount: z.number().optional().describe("Number of messages returned"),
  messages: z
    .array(
      z.object({
        timestamp: z.string().describe("Message timestamp"),
        messageId: z.string().describe("Message ID (e.g., RNF7030)"),
        messageType: z.string().describe("Message type"),
        severity: z.number().describe("Message severity (0-99)"),
        messageText: z.string().describe("Primary message text"),
        secondLevelText: z
          .string()
          .nullable()
          .optional()
          .describe("Detailed help text"),
        fromProgram: z.string().optional().describe("Program that sent message"),
        fromLibrary: z.string().optional().describe("Library of sending program"),
      }),
    )
    .optional()
    .describe("Array of error/warning messages"),
  executionTime: z.number().optional().describe("Execution time in milliseconds"),
  error: z
    .object({
      code: z.string().describe("Error code"),
      message: z.string().describe("Error message"),
      details: z.record(z.unknown()).optional().describe("Error details"),
    })
    .optional()
    .describe("Error information if the query failed."),
});

type GetCompileErrorsInput = z.infer<typeof GetCompileErrorsInputSchema>;
type GetCompileErrorsOutput = z.infer<typeof GetCompileErrorsOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

export async function getCompileErrorsLogic(
  params: GetCompileErrorsInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<GetCompileErrorsOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing get compile errors logic.",
  );

  const startTime = Date.now();
  const { min_severity, max_messages, message_type_filter } = params;

  try {
    // Build message type filter
    const messageTypes =
      message_type_filter ||
      ["COMPLETION", "DIAGNOSTIC", "ESCAPE", "NOTIFY", "INFORMATIONAL"];
    const messageTypesList = messageTypes.map((t) => `'${t}'`).join(", ");

    // Query job log for compilation messages
    const sql = `
      SELECT 
        MESSAGE_TIMESTAMP,
        MESSAGE_ID,
        MESSAGE_TYPE,
        SEVERITY,
        MESSAGE_TEXT,
        MESSAGE_SECOND_LEVEL_TEXT,
        FROM_PROGRAM,
        FROM_LIBRARY,
        MESSAGE_FILE,
        MESSAGE_LIBRARY
      FROM TABLE(QSYS2.JOBLOG_INFO('*')) 
      WHERE MESSAGE_TYPE IN (${messageTypesList})
        AND SEVERITY >= ?
      ORDER BY MESSAGE_TIMESTAMP DESC
      FETCH FIRST ? ROWS ONLY
    `.trim();

    const result = await IBMiConnectionPool.executeQuery(
      sql,
      [min_severity, max_messages],
      appContext,
    );

    if (!result.data) {
      return {
        success: true,
        messageCount: 0,
        messages: [],
        executionTime: Date.now() - startTime,
      };
    }

    // Transform messages
    const messages = result.data.map((row: any) => ({
      timestamp: row.MESSAGE_TIMESTAMP,
      messageId: row.MESSAGE_ID,
      messageType: row.MESSAGE_TYPE,
      severity: row.SEVERITY,
      messageText: row.MESSAGE_TEXT,
      secondLevelText: row.MESSAGE_SECOND_LEVEL_TEXT,
      fromProgram: row.FROM_PROGRAM,
      fromLibrary: row.FROM_LIBRARY,
    }));

    const executionTime = Date.now() - startTime;

    return {
      success: true,
      messageCount: messages.length,
      messages,
      executionTime,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;

    logger.error(
      {
        ...appContext,
        error: error instanceof Error ? error.message : String(error),
        executionTime,
      },
      "Get compile errors failed.",
    );

    if (error instanceof McpError) {
      return {
        success: false,
        executionTime,
        error: {
          code: String(error.code),
          message: error.message,
          details: error.details,
        },
      };
    }

    return {
      success: false,
      executionTime,
      error: {
        code: String(JsonRpcErrorCode.InternalError),
        message: `Failed to get compile errors: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// =============================================================================
// Response Formatter
// =============================================================================

const getCompileErrorsResponseFormatter = (
  result: GetCompileErrorsOutput,
): ContentBlock[] => {
  if (!result.success) {
    const errorMessage = result.error?.message || "Failed to get compile errors";
    const errorDetails = result.error?.details
      ? `\n\nDetails:\n${JSON.stringify(result.error.details, null, 2)}`
      : "";
    return [{ type: "text", text: `Error: ${errorMessage}${errorDetails}` }];
  }

  if (!result.messages || result.messages.length === 0) {
    return [
      {
        type: "text",
        text: "No compilation errors or warnings found in the job log.",
      },
    ];
  }

  const header = `Found ${result.messageCount} message(s)\nExecution time: ${result.executionTime}ms\n\n${"=".repeat(80)}\n`;

  const messagesList = result.messages
    .map((msg, index) => {
      const severityIcon =
        msg.severity >= 40 ? "🔴" : msg.severity >= 30 ? "🟠" : "🟡";
      return `
${index + 1}. ${severityIcon} ${msg.messageId} - Severity ${msg.severity}
   Type: ${msg.messageType}
   Time: ${msg.timestamp}

   ${msg.messageText}
   ${msg.secondLevelText ? `\n   Details: ${msg.secondLevelText}` : ""}
   ${msg.fromProgram ? `\n   From: ${msg.fromLibrary}/${msg.fromProgram}` : ""}
${"=".repeat(80)}`;
    })
    .join("\n");

  return [
    {
      type: "text",
      text: `${header}${messagesList}`,
    },
  ];
};

// =============================================================================
// Tool Definition
// =============================================================================

export const getCompileErrorsTool = defineTool({
  name: "get_compile_errors",
  title: "Get Compile Errors",
  description:
    "Retrieve compilation error messages from the current job log. Returns detailed error messages with severity, message ID, and help text for AI analysis and fixing. Use this after a compile_source operation fails.",
  inputSchema: GetCompileErrorsInputSchema,
  outputSchema: GetCompileErrorsOutputSchema,
  logic: getCompileErrorsLogic,
  responseFormatter: getCompileErrorsResponseFormatter,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
});
