/**
 * Read Source Member Tool
 *
 * Reads IBM i source code from a source physical file member.
 * Returns source code with line numbers and metadata.
 *
 * @module readSourceMember.tool
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

const ReadSourceMemberInputSchema = z.object({
  library: z
    .string()
    .min(1, "Library name cannot be empty.")
    .max(10, "Library name cannot exceed 10 characters.")
    .describe("Library containing the source file (e.g., 'MYLIB', 'QGPL')"),
  source_file: z
    .string()
    .min(1, "Source file name cannot be empty.")
    .max(10, "Source file name cannot exceed 10 characters.")
    .describe("Source file name (e.g., 'QRPGLESRC', 'QCLSRC')"),
  member: z
    .string()
    .min(1, "Member name cannot be empty.")
    .max(10, "Member name cannot exceed 10 characters.")
    .describe("Source member name (e.g., 'MYPGM')"),
  include_line_numbers: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include line numbers in output (default: true)"),
});

const ReadSourceMemberOutputSchema = z.object({
  success: z.boolean().describe("Whether the operation was successful."),
  library: z.string().optional().describe("Library name"),
  sourceFile: z.string().optional().describe("Source file name"),
  member: z.string().optional().describe("Member name"),
  sourceType: z.string().optional().describe("Source type (e.g., RPGLE, CLLE, SQLRPGLE)"),
  lineCount: z.number().optional().describe("Number of source lines"),
  sourceCode: z.string().optional().describe("Source code content"),
  lastModified: z.string().optional().describe("Last modification timestamp"),
  executionTime: z.number().optional().describe("Execution time in milliseconds"),
  error: z
    .object({
      code: z.string().describe("Error code"),
      message: z.string().describe("Error message"),
      details: z.record(z.unknown()).optional().describe("Error details"),
    })
    .optional()
    .describe("Error information if the operation failed."),
});

type ReadSourceMemberInput = z.infer<typeof ReadSourceMemberInputSchema>;
type ReadSourceMemberOutput = z.infer<typeof ReadSourceMemberOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

export async function readSourceMemberLogic(
  params: ReadSourceMemberInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ReadSourceMemberOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing read source member logic.",
  );

  const startTime = Date.now();
  const { library, source_file, member, include_line_numbers } = params;

  try {
    // First, get metadata about the source member
    const metadataSql = `
      SELECT 
        SYSTEM_TABLE_SCHEMA AS LIBRARY,
        SYSTEM_TABLE_NAME AS SOURCE_FILE,
        SYSTEM_TABLE_MEMBER AS MEMBER,
        SOURCE_TYPE,
        NUMBER_ROWS AS LINE_COUNT,
        LAST_SOURCE_UPDATE_TIMESTAMP
      FROM QSYS2.SYSPARTITIONSTAT
      WHERE SYSTEM_TABLE_SCHEMA = UPPER(?)
        AND SYSTEM_TABLE_NAME = UPPER(?)
        AND SYSTEM_TABLE_MEMBER = UPPER(?)
    `.trim();

    const metadataResult = await IBMiConnectionPool.executeQuery(
      metadataSql,
      [library, source_file, member],
      appContext,
    );

    if (!metadataResult.data || metadataResult.data.length === 0) {
      return {
        success: false,
        executionTime: Date.now() - startTime,
        error: {
          code: String(JsonRpcErrorCode.InvalidRequest),
          message: `Source member not found: ${library}/${source_file}(${member})`,
        },
      };
    }

    const metadata = metadataResult.data[0] as Record<string, any>;

    // Build IFS path to source member
    const ifsPath = `/QSYS.LIB/${library.toUpperCase()}.LIB/${source_file.toUpperCase()}.FILE/${member.toUpperCase()}.MBR`;

    // Read source code using IFS_READ_UTF8
    const sourceSql = `
      SELECT LINE_NUMBER, LINE
      FROM TABLE(QSYS2.IFS_READ_UTF8(PATH_NAME => '${ifsPath}'))
      ORDER BY LINE_NUMBER
    `.trim();

    const sourceResult = await IBMiConnectionPool.executeQuery(
      sourceSql,
      [],
      appContext,
    );

    if (!sourceResult.data) {
      return {
        success: false,
        executionTime: Date.now() - startTime,
        error: {
          code: String(JsonRpcErrorCode.InternalError),
          message: "Failed to read source code",
        },
      };
    }

    // Format source code with optional line numbers
    const sourceCode = sourceResult.data
      .map((row: any) => {
        const lineNum = row.LINE_NUMBER || 0;
        const line = row.LINE || "";
        if (include_line_numbers) {
          return `${String(lineNum).padStart(6, " ")}  ${line}`;
        }
        return line;
      })
      .join("\n");

    const executionTime = Date.now() - startTime;

    return {
      success: true,
      library: metadata.LIBRARY,
      sourceFile: metadata.SOURCE_FILE,
      member: metadata.MEMBER,
      sourceType: metadata.SOURCE_TYPE,
      lineCount: metadata.LINE_COUNT,
      sourceCode,
      lastModified: metadata.LAST_SOURCE_UPDATE_TIMESTAMP,
      executionTime,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;

    logger.error(
      {
        ...appContext,
        error: error instanceof Error ? error.message : String(error),
        library,
        sourceFile: source_file,
        member,
        executionTime,
      },
      "Read source member failed.",
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
        message: `Failed to read source member: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// =============================================================================
// Response Formatter
// =============================================================================

const readSourceMemberResponseFormatter = (
  result: ReadSourceMemberOutput,
): ContentBlock[] => {
  if (!result.success) {
    const errorMessage =
      result.error?.message || "Failed to read source member";
    const errorDetails = result.error?.details
      ? `\n\nDetails:\n${JSON.stringify(result.error.details, null, 2)}`
      : "";
    return [{ type: "text", text: `Error: ${errorMessage}${errorDetails}` }];
  }

  const header = `Source: ${result.library}/${result.sourceFile}(${result.member})
Type: ${result.sourceType}
Lines: ${result.lineCount}
Last Modified: ${result.lastModified}
Execution time: ${result.executionTime}ms

Source Code:
${"=".repeat(80)}
`;

  return [
    {
      type: "text",
      text: `${header}${result.sourceCode}\n${"=".repeat(80)}`,
    },
  ];
};

// =============================================================================
// Tool Definition
// =============================================================================

export const readSourceMemberTool = defineTool({
  name: "read_source_member",
  title: "Read Source Member",
  description:
    "Read IBM i source code from a source physical file member. Returns the complete source code with line numbers and metadata including source type, line count, and last modification timestamp.",
  inputSchema: ReadSourceMemberInputSchema,
  outputSchema: ReadSourceMemberOutputSchema,
  logic: readSourceMemberLogic,
  responseFormatter: readSourceMemberResponseFormatter,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
});
