/**
 * Read Spool File Tool
 *
 * Retrieves the contents of an IBM i spool file (e.g., compilation listings).
 * This tool is essential for reading detailed compiler error messages.
 *
 * @module readSpoolFile.tool
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

const ReadSpoolFileInputSchema = z.object({
  job_name: z
    .string()
    .optional()
    .describe("Job name in format NUMBER/USER/NAME (e.g., '123456/USER/QZDASOINIT'). Use '*' for current job"),
  spool_file: z
    .string()
    .optional()
    .default("*LAST")
    .describe("Spool file name or '*LAST' for most recent spool file"),
  spool_number: z
    .number()
    .optional()
    .describe("Spool file number (if multiple files with same name)"),
  max_records: z
    .number()
    .optional()
    .default(500)
    .describe("Maximum number of records to retrieve"),
});

const ReadSpoolFileOutputSchema = z.object({
  success: z.boolean().describe("Whether the operation succeeded."),
  spoolFile: z.string().optional().describe("Spool file name"),
  jobName: z.string().optional().describe("Job name"),
  fileNumber: z.number().optional().describe("Spool file number"),
  recordCount: z.number().optional().describe("Number of records retrieved"),
  content: z.string().optional().describe("Spool file content"),
  executionTime: z.number().optional().describe("Execution time in milliseconds"),
  error: z
    .object({
      code: z.string().describe("Error code"),
      message: z.string().describe("Error message"),
      details: z.record(z.unknown()).optional().describe("Error details"),
    })
    .optional()
    .describe("Error information if operation failed."),
});

type ReadSpoolFileInput = z.infer<typeof ReadSpoolFileInputSchema>;
type ReadSpoolFileOutput = z.infer<typeof ReadSpoolFileOutputSchema>;

// =============================================================================
// Business Logic
// =============================================================================

export async function readSpoolFileLogic(
  params: ReadSpoolFileInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ReadSpoolFileOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing read spool file logic.",
  );

  const startTime = Date.now();
  const { job_name, spool_file, spool_number, max_records } = params;

  try {
    // Query to get spool file data using OUTPUT_QUEUE_ENTRIES_BASIC
    // and SPOOL_FILE_DATA services
    const jobFilter = job_name || "*";
    const spoolFilter = spool_file || "*LAST";

    // First, find the spool file entry
    let findSpoolSql = `
      SELECT 
        JOB_NAME,
        SPOOLED_FILE_NAME,
        FILE_NUMBER,
        USER_NAME,
        CREATE_TIMESTAMP
      FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC
      WHERE 1=1
    `;

    const sqlParams: any[] = [];

    if (jobFilter !== "*") {
      findSpoolSql += ` AND JOB_NAME = ?`;
      sqlParams.push(jobFilter);
    }

    if (spoolFilter !== "*LAST") {
      findSpoolSql += ` AND SPOOLED_FILE_NAME = ?`;
      sqlParams.push(spoolFilter);
    }

    if (spool_number) {
      findSpoolSql += ` AND FILE_NUMBER = ?`;
      sqlParams.push(spool_number);
    }

    findSpoolSql += `
      ORDER BY CREATE_TIMESTAMP DESC
      FETCH FIRST 1 ROW ONLY
    `;

    const spoolEntry = await IBMiConnectionPool.executeQuery(
      findSpoolSql,
      sqlParams,
      appContext,
    );

    if (!spoolEntry.data || spoolEntry.data.length === 0) {
      return {
        success: false,
        executionTime: Date.now() - startTime,
        error: {
          code: String(JsonRpcErrorCode.InvalidRequest),
          message: `No spool file found matching criteria: job=${jobFilter}, file=${spoolFilter}`,
        },
      };
    }

    const entry = spoolEntry.data[0] as any;
    const fullJobName = entry.JOB_NAME as string;
    const fileName = entry.SPOOLED_FILE_NAME as string;
    const fileNum = entry.FILE_NUMBER as number;

    // Use SYSTOOLS.SPOOLED_FILE_DATA - available on IBM i 7.5+
    // This is the recommended IBM i method for reading spool file content
    const readSpoolSql = `
      SELECT ORDINAL_POSITION, SPOOLED_DATA
      FROM TABLE(SYSTOOLS.SPOOLED_FILE_DATA(
        JOB_NAME => ?,
        SPOOLED_FILE_NAME => ?,
        SPOOLED_FILE_NUMBER => ?
      ))
      ORDER BY ORDINAL_POSITION
      FETCH FIRST ? ROWS ONLY
    `;

    // Note: We pass max_records as BOTH a SQL parameter (in FETCH FIRST ? ROWS)
    // AND as the rowsToFetch argument to ensure Mapepire fetches that many rows.
    // Mapepire defaults to 100 rows if rowsToFetch is not specified.
    const spoolData = await IBMiConnectionPool.executeQuery(
      readSpoolSql,
      [fullJobName, fileName, fileNum, max_records],
      appContext,
      max_records, // Pass max_records as rowsToFetch parameter
    );

    if (!spoolData.data || spoolData.data.length === 0) {
      return {
        success: true,
        spoolFile: fileName,
        jobName: fullJobName,
        fileNumber: fileNum,
        recordCount: 0,
        content: "",
        executionTime: Date.now() - startTime,
      };
    }

    // Combine all spool data lines
    const content = spoolData.data
      .map((row: any) => row.SPOOLED_DATA)
      .join("\n");

    const executionTime = Date.now() - startTime;

    return {
      success: true,
      spoolFile: fileName,
      jobName: fullJobName,
      fileNumber: fileNum,
      recordCount: spoolData.data.length,
      content,
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
      "Read spool file failed.",
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
        message: `Failed to read spool file: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// =============================================================================
// Response Formatter
// =============================================================================

const readSpoolFileResponseFormatter = (
  result: ReadSpoolFileOutput,
): ContentBlock[] => {
  if (!result.success) {
    const errorMessage = result.error?.message || "Failed to read spool file";
    const errorDetails = result.error?.details
      ? `\n\nDetails:\n${JSON.stringify(result.error.details, null, 2)}`
      : "";
    return [
      {
        type: "text",
        text: `Error reading spool file: ${errorMessage}${errorDetails}`,
      },
    ];
  }

  const header = `Spool File: ${result.spoolFile || "N/A"}
Job: ${result.jobName || "N/A"}
File Number: ${result.fileNumber || "N/A"}
Records: ${result.recordCount || 0}
Execution time: ${result.executionTime}ms

Spool File Content:
${"=".repeat(80)}
${result.content || "(empty)"}
${"=".repeat(80)}`;

  return [
    {
      type: "text",
      text: header,
    },
  ];
};

// =============================================================================
// Tool Registration
// =============================================================================

export const readSpoolFileTool = defineTool({
  name: "read_spool_file",
  title: "Read Spool File",
  description:
    "Read the contents of an IBM i spool file (e.g., compilation listing). " +
    "Use this to retrieve detailed compiler error messages after a compilation failure. " +
    "Specify job_name or use '*' for current job, and spool_file name or '*LAST' for most recent.",
  inputSchema: ReadSpoolFileInputSchema,
  outputSchema: ReadSpoolFileOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  logic: readSpoolFileLogic,
  responseFormatter: readSpoolFileResponseFormatter,
});
