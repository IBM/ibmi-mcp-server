/**
 * Write Source Member Tool
 *
 * Writes or updates IBM i source code in a source physical file member.
 * This enables AI-driven code generation and automated fixes.
 *
 * Uses IFS + CPYFRMSTMF approach for atomic, reliable writes that bypass
 * connection pool transaction issues.
 *
 * @module writeSourceMember.tool
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

const WriteSourceMemberInputSchema = z.object({
  library: z
    .string()
    .min(1, "Library name cannot be empty.")
    .max(10, "Library name cannot exceed 10 characters.")
    .describe("Library containing the source file"),
  source_file: z
    .string()
    .min(1, "Source file name cannot be empty.")
    .max(10, "Source file name cannot exceed 10 characters.")
    .describe("Source file name (e.g., 'QRPGLESRC', 'QCLSRC')"),
  member: z
    .string()
    .min(1, "Member name cannot be empty.")
    .max(10, "Member name cannot exceed 10 characters.")
    .describe("Source member name to write"),
  source_code: z
    .string()
    .min(1, "Source code cannot be empty.")
    .describe("Complete source code content to write to the member"),
  source_type: z
    .string()
    .optional()
    .default("RPGLE")
    .describe("Source type (e.g., 'RPGLE', 'CLLE', 'SQLRPGLE')"),
  text_description: z
    .string()
    .optional()
    .describe("Member text description"),
  replace_existing: z
    .boolean()
    .optional()
    .default(true)
    .describe("Replace existing member if it exists (default: true)"),
});

const WriteSourceMemberOutputSchema = z.object({
  success: z.boolean().describe("Whether the operation was successful."),
  library: z.string().optional(),
  sourceFile: z.string().optional(),
  member: z.string().optional(),
  sourceType: z.string().optional(),
  linesWritten: z.number().optional().describe("Number of lines written"),
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

type WriteSourceMemberInput = z.infer<typeof WriteSourceMemberInputSchema>;
type WriteSourceMemberOutput = z.infer<typeof WriteSourceMemberOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

/**
 * Helper: Write text to IFS using QSYS2.IFS_WRITE_UTF8
 */
async function writeToIFS(
  ifsPath: string,
  content: string,
  context: RequestContext
): Promise<void> {
  logger.debug({ ...context, ifsPath }, "Writing content to IFS");

  // Split content into lines - IFS_WRITE_UTF8 writes line by line
  const lines = content.split('\n');

  // First line: REPLACE mode (overwrites file)
  if (lines.length > 0) {
    const firstLineSQL = `
      CALL QSYS2.IFS_WRITE_UTF8(
        PATH_NAME => ?,
        LINE => ?,
        OVERWRITE => 'REPLACE',
        END_OF_LINE => 'LF'
      )
    `;
    await IBMiConnectionPool.executeQuery(
      firstLineSQL,
      [ifsPath, lines[0] || ''],
      context
    );
  }

  // Remaining lines: APPEND mode
  for (let i = 1; i < lines.length; i++) {
    const appendLineSQL = `
      CALL QSYS2.IFS_WRITE_UTF8(
        PATH_NAME => ?,
        LINE => ?,
        OVERWRITE => 'APPEND',
        END_OF_LINE => 'LF'
      )
    `;
    await IBMiConnectionPool.executeQuery(
      appendLineSQL,
      [ifsPath, lines[i] || ''],
      context
    );
  }

  logger.info({ ...context, ifsPath, lines: lines.length }, "Successfully wrote content to IFS");
}

/**
 * Helper: Delete IFS file
 */
async function deleteFromIFS(
  ifsPath: string,
  context: RequestContext
): Promise<void> {
  try {
    // Simple rm command - ignore errors if file doesn't exist
    const rmCmd = `rm -f ${ifsPath}`;
    await IBMiConnectionPool.executeQuery(
      `CALL QSYS2.QCMDEXC(?)`,
      [rmCmd],
      context
    );
    logger.debug({ ...context, ifsPath }, "Deleted IFS file");
  } catch (error) {
    // Ignore errors - file might not exist or already deleted
    logger.debug({ ...context, ifsPath, error }, "Could not delete IFS file (may not exist)");
  }
}

export async function writeSourceMemberLogic(
  params: WriteSourceMemberInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<WriteSourceMemberOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing write source member logic using IFS+CPYFRMSTMF approach.",
  );

  const startTime = Date.now();
  const {
    library,
    source_file,
    member,
    source_code,
    source_type,
    text_description,
    replace_existing,
  } = params;

  // Generate unique temporary IFS path
  const timestamp = Date.now();
  const ifsPath = `/tmp/mcp_${member}_${timestamp}.tmp`;

  try {
    const lines = source_code.split('\n');
    logger.info(
      { ...appContext, library, sourceFile: source_file, member, lines: lines.length },
      "Writing source member using IFS+CPYFRMSTMF"
    );

    // Step 1: Prepare source member (create or clear)
    const textDesc = text_description || `AI-generated ${source_type} code`;

    if (replace_existing) {
      // Try to remove existing member, then create new one
      try {
        const rmvCmd = `RMVM FILE(${library}/${source_file}) MBR(${member})`;
        await IBMiConnectionPool.executeQuery(
          `CALL QSYS2.QCMDEXC(?)`,
          [rmvCmd],
          appContext
        );
        logger.info({ ...appContext, member }, "Removed existing member");
      } catch (rmvError) {
        // Member doesn't exist - that's OK
        logger.debug({ ...appContext, member }, "Member didn't exist (OK)");
      }
    }

    // Create the member (will fail if exists and replace_existing=false)
    const createCmd = `ADDPFM FILE(${library}/${source_file}) MBR(${member}) SRCTYPE(${source_type}) TEXT('${textDesc}')`;
    await IBMiConnectionPool.executeQuery(
      `CALL QSYS2.QCMDEXC(?)`,
      [createCmd],
      appContext
    );
    logger.info({ ...appContext, member, sourceType: source_type }, "Created source member");

    // Step 2: Write source code to temporary IFS file
    logger.info({ ...appContext, ifsPath }, "Writing source to temporary IFS file");
    await writeToIFS(ifsPath, source_code, appContext);

    // Step 3: Copy from IFS to source member using CPYFRMSTMF (ATOMIC operation!)
    const memberPath = `/QSYS.LIB/${library}.LIB/${source_file}.FILE/${member}.MBR`;
    const copyCmd = `CPYFRMSTMF FROMSTMF('${ifsPath}') TOMBR('${memberPath}') MBROPT(*REPLACE)`;

    logger.info(
      { ...appContext, ifsPath, memberPath },
      "Copying from IFS to source member (atomic operation)"
    );

    await IBMiConnectionPool.executeQuery(
      `CALL QSYS2.QCMDEXC(?)`,
      [copyCmd],
      appContext
    );

    logger.info({ ...appContext, member }, "Successfully copied to source member");

    // Step 4: Clean up temporary IFS file
    await deleteFromIFS(ifsPath, appContext);

    // Step 5: VERIFY the data was actually persisted
    // Note: Old-style source files don't have SRCMBR column, so we verify using the member path
    logger.debug({ ...appContext, member }, "Verifying source member was persisted");

    try {
      // Use QSYS2.SYSPARTITIONSTAT to verify member exists and has data
      const verifySQL = `
        SELECT NUMBER_ROWS as LINE_COUNT
        FROM QSYS2.SYSPARTITIONSTAT
        WHERE TABLE_SCHEMA = '${library}'
          AND TABLE_NAME = '${source_file}'
          AND SYSTEM_TABLE_MEMBER = '${member}'
      `;
      const verifyResult = await IBMiConnectionPool.executeQuery(
        verifySQL,
        [],
        appContext
      );

      const actualLines = (verifyResult.data?.[0] as any)?.LINE_COUNT ?? 0;

      if (actualLines === 0) {
        logger.error(
          { ...appContext, member, expected: lines.length, actual: actualLines },
          "Verification failed: member has no rows"
        );

        throw new McpError(
          JsonRpcErrorCode.InternalError,
          `Verification failed: Member ${library}/${source_file}(${member}) exists but has no data`,
          {
            expected: lines.length,
            actual: actualLines,
            library,
            sourceFile: source_file,
            member
          }
        );
      }

      logger.info(
        { ...appContext, member, verifiedLines: actualLines },
        "Verification successful: member has data"
      );
    } catch (verifyError) {
      if (verifyError instanceof McpError) {
        throw verifyError;
      }

      logger.error(
        { ...appContext, member, error: verifyError },
        "Verification query failed"
      );

      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `Could not verify source member was persisted: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`,
        {
          originalError: verifyError instanceof Error ? verifyError.message : String(verifyError)
        }
      );
    }

    const executionTime = Date.now() - startTime;

    logger.info(
      { ...appContext, member, linesWritten: lines.length, executionTime },
      "Source member written and verified successfully",
    );

    return {
      success: true,
      library,
      sourceFile: source_file,
      member,
      sourceType: source_type,
      linesWritten: lines.length,
      executionTime,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;

    // Clean up temporary IFS file on error
    await deleteFromIFS(ifsPath, appContext);

    logger.error(
      {
        ...appContext,
        error: error instanceof Error ? error.message : String(error),
        library,
        member,
        executionTime,
      },
      "Write source member failed.",
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
        message: `Failed to write source member: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// =============================================================================
// Response Formatter
// =============================================================================

const writeSourceMemberResponseFormatter = (
  result: WriteSourceMemberOutput,
): ContentBlock[] => {
  if (!result.success) {
    const errorMessage = result.error?.message || "Failed to write source member";
    const errorDetails = result.error?.details
      ? `\n\nDetails:\n${JSON.stringify(result.error.details, null, 2)}`
      : "";
    return [
      {
        type: "text",
        text: `Error writing source member: ${errorMessage}${errorDetails}`,
      },
    ];
  }

  const summary = `✅ Source Member Written Successfully

Library: ${result.library}
Source File: ${result.sourceFile}
Member: ${result.member}
Type: ${result.sourceType}
Lines Written: ${result.linesWritten}
Execution Time: ${result.executionTime}ms

The source code has been written to ${result.library}/${result.sourceFile}(${result.member}).
You can now compile it using the compile_source tool.`;

  return [
    {
      type: "text",
      text: summary,
    },
  ];
};

// =============================================================================
// Tool Registration
// =============================================================================

export const writeSourceMemberTool = defineTool({
  name: "write_source_member",
  title: "Write Source Member",
  description:
    "Write or update IBM i source code in a source physical file member. " +
    "This tool enables AI-driven code generation and automated fixes. " +
    "Use this to create new source members or update existing ones with corrected code. " +
    "The source code should be provided as a complete multi-line string.",
  inputSchema: WriteSourceMemberInputSchema,
  outputSchema: WriteSourceMemberOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true, // This modifies source code!
    openWorldHint: false,
  },
  logic: writeSourceMemberLogic,
  responseFormatter: writeSourceMemberResponseFormatter,
});
