/**
 * Compile Source Tool
 *
 * Compiles IBM i source code (RPG, CL, COBOL, etc.) and returns
 * compilation status and job information.
 *
 * @module compileSource.tool
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

const CompileSourceInputSchema = z.object({
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
    .describe("Source member name to compile"),
  target_library: z
    .string()
    .optional()
    .describe("Library for compiled object (defaults to source library)"),
  compile_type: z
    .enum(["RPGLE", "SQLRPGLE", "CL", "CLLE", "CBL", "CBLLE"])
    .describe("Source type to compile"),
  compile_options: z
    .string()
    .optional()
    .describe("Additional compile options (e.g., 'DBGVIEW(*SOURCE)')"),
  create_program: z
    .boolean()
    .optional()
    .default(false)
    .describe("Create bound program instead of module (default: false)"),
});

const CompileSourceOutputSchema = z.object({
  success: z.boolean().describe("Whether compilation succeeded."),
  library: z.string().optional(),
  member: z.string().optional(),
  compileType: z.string().optional(),
  command: z.string().optional().describe("Compile command that was executed"),
  jobName: z.string().optional().describe("Job that ran the compile"),
  executionTime: z.number().optional().describe("Execution time in milliseconds"),
  error: z
    .object({
      code: z.string().describe("Error code"),
      message: z.string().describe("Error message"),
      details: z.record(z.unknown()).optional().describe("Error details"),
    })
    .optional()
    .describe("Error information if compilation failed."),
});

type CompileSourceInput = z.infer<typeof CompileSourceInputSchema>;
type CompileSourceOutput = z.infer<typeof CompileSourceOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

export async function compileSourceLogic(
  params: CompileSourceInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<CompileSourceOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing compile source logic.",
  );

  const startTime = Date.now();
  const {
    library,
    source_file,
    member,
    target_library,
    compile_type,
    compile_options,
    create_program,
  } = params;

  const targetLib = target_library || library;

  try {
    // Build compile command based on type
    let compileCmd = "";

    switch (compile_type) {
      case "RPGLE":
        if (create_program) {
          compileCmd = `CRTBNDRPG PGM(${targetLib}/${member}) SRCFILE(${library}/${source_file}) SRCMBR(${member}) ${compile_options || ""}`;
        } else {
          compileCmd = `CRTRPGMOD MODULE(${targetLib}/${member}) SRCFILE(${library}/${source_file}) SRCMBR(${member}) ${compile_options || ""}`;
        }
        break;

      case "SQLRPGLE":
        compileCmd = `CRTSQLRPGI OBJ(${targetLib}/${member}) SRCFILE(${library}/${source_file}) SRCMBR(${member}) ${compile_options || ""}`;
        break;

      case "CL":
      case "CLLE":
        if (create_program) {
          compileCmd = `CRTBNDCL PGM(${targetLib}/${member}) SRCFILE(${library}/${source_file}) SRCMBR(${member}) ${compile_options || ""}`;
        } else {
          compileCmd = `CRTCLMOD MODULE(${targetLib}/${member}) SRCFILE(${library}/${source_file}) SRCMBR(${member}) ${compile_options || ""}`;
        }
        break;

      case "CBL":
      case "CBLLE":
        if (create_program) {
          compileCmd = `CRTBNDCBL PGM(${targetLib}/${member}) SRCFILE(${library}/${source_file}) SRCMBR(${member}) ${compile_options || ""}`;
        } else {
          compileCmd = `CRTCBLMOD MODULE(${targetLib}/${member}) SRCFILE(${library}/${source_file}) SRCMBR(${member}) ${compile_options || ""}`;
        }
        break;

      default:
        return {
          success: false,
          executionTime: Date.now() - startTime,
          error: {
            code: String(JsonRpcErrorCode.InvalidRequest),
            message: `Unsupported compile type: ${compile_type}`,
          },
        };
    }

    // Add QRPGLE library to library list before compiling
    // This ensures message files like QRPGLEMSG are found
    const addLibListSql = `CALL QSYS2.QCMDEXC(COMMAND => ?)`;

    try {
      await IBMiConnectionPool.executeQuery(addLibListSql, ['ADDLIBLE LIB(QRPGLE) POSITION(*LAST)'], appContext);
      logger.debug({ ...appContext }, "Added QRPGLE to library list");
    } catch (libListError) {
      logger.info(
        { ...appContext, error: libListError instanceof Error ? libListError.message : String(libListError) },
        "Failed to add QRPGLE to library list (continuing anyway)"
      );
    }

    try {
      await IBMiConnectionPool.executeQuery(addLibListSql, ['ADDLIBLE LIB(QDEVTOOLS) POSITION(*LAST)'], appContext);
      logger.debug({ ...appContext }, "Added QDEVTOOLS to library list");
    } catch (libListError) {
      logger.info(
        { ...appContext, error: libListError instanceof Error ? libListError.message : String(libListError) },
        "Failed to add QDEVTOOLS to library list (continuing anyway)"
      );
    }

    // Execute compile command using QCMDEXC
    // Use QSYS2.QCMDEXC with SPECIFIC_NAME QCMDEXC1 (single parameter version)
    // This version auto-calculates the command length
    const sql = `CALL QSYS2.QCMDEXC(COMMAND => ?)`;

    logger.info(
      { ...appContext, command: compileCmd },
      "Executing compile command",
    );

    await IBMiConnectionPool.executeQuery(sql, [compileCmd], appContext);

    const executionTime = Date.now() - startTime;

    return {
      success: true,
      library: targetLib,
      member,
      compileType: compile_type,
      command: compileCmd,
      executionTime,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;

    logger.error(
      {
        ...appContext,
        error: error instanceof Error ? error.message : String(error),
        library,
        member,
        compileType: compile_type,
        executionTime,
      },
      "Compile source failed.",
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
      library: targetLib,
      member,
      compileType: compile_type,
      executionTime,
      error: {
        code: String(JsonRpcErrorCode.InternalError),
        message: `Compilation failed: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          note: "Check job log for detailed error messages using get_job_log_messages or get_compile_errors tools",
        },
      },
    };
  }
}

// =============================================================================
// Response Formatter
// =============================================================================

const compileSourceResponseFormatter = (
  result: CompileSourceOutput,
): ContentBlock[] => {
  if (!result.success) {
    const errorMessage = result.error?.message || "Compilation failed";
    const errorDetails = result.error?.details
      ? `\n\nDetails:\n${JSON.stringify(result.error.details, null, 2)}`
      : "";

    const note = result.error?.details?.note
      ? `\n\n💡 ${result.error.details.note}`
      : "";

    return [
      {
        type: "text",
        text: `❌ Compilation Failed\n\nLibrary: ${result.library}\nMember: ${result.member}\nType: ${result.compileType}\n\nError: ${errorMessage}${errorDetails}${note}`,
      },
    ];
  }

  return [
    {
      type: "text",
      text: `✅ Compilation Successful\n\nLibrary: ${result.library}\nMember: ${result.member}\nType: ${result.compileType}\nCommand: ${result.command}\nExecution time: ${result.executionTime}ms`,
    },
  ];
};

// =============================================================================
// Tool Definition
// =============================================================================

export const compileSourceTool = defineTool({
  name: "compile_source",
  title: "Compile Source",
  description:
    "Compile IBM i source code (RPG, CL, COBOL) into modules or programs. Returns compilation status and job information. Use get_job_log_messages or get_compile_errors tools to retrieve detailed error messages if compilation fails.",
  inputSchema: CompileSourceInputSchema,
  outputSchema: CompileSourceOutputSchema,
  logic: compileSourceLogic,
  responseFormatter: compileSourceResponseFormatter,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
});
