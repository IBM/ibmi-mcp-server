/**
 * Validate Query Tool
 *
 * Validates SQL query syntax using IBM i's native PARSE_STATEMENT table function,
 * then cross-references parsed table and column names against the system catalog
 * (SYSTABLES / SYSCOLUMNS2) to detect hallucinated object names.
 *
 * @module validateQuery.tool
 */

import { z } from "zod";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { JsonRpcErrorCode, McpError } from "../../types-global/errors.js";
import type { RequestContext } from "../../utils/index.js";
import { logger } from "../../utils/internal/logger.js";
import { IBMiConnectionPool } from "../services/connectionPool.js";
import { defineTool } from "../../mcp-server/tools/utils/tool-factory.js";
import type { SdkContext } from "../../mcp-server/tools/utils/types.js";

// =============================================================================
// Types
// =============================================================================

interface TableRef {
  schema: string;
  name: string;
}

interface ColumnRef {
  columnName: string;
  schema?: string;
  tableName?: string;
}

interface ObjectValidation {
  tables: { valid: string[]; invalid: string[] };
  columns: { valid: string[]; invalid: string[] };
}

// =============================================================================
// Schemas
// =============================================================================

const ValidateQueryInputSchema = z.object({
  sql_statement: z
    .string()
    .min(5, "SQL statement must be at least 5 characters.")
    .max(10000, "SQL statement cannot exceed 10000 characters.")
    .describe(
      "SQL statement to validate (e.g., 'SELECT * FROM QIWS.QCUSTCDT')",
    ),
});

const ObjectValidationSchema = z.object({
  tables: z.object({
    valid: z.array(z.string()).describe("Tables confirmed to exist."),
    invalid: z.array(z.string()).describe("Tables not found in system catalog."),
  }),
  columns: z.object({
    valid: z.array(z.string()).describe("Columns confirmed to exist."),
    invalid: z
      .array(z.string())
      .describe("Columns not found in any referenced table."),
  }),
});

const ValidateQueryOutputSchema = z.object({
  success: z.boolean().describe("Whether the validation executed successfully."),
  data: z
    .array(z.record(z.unknown()))
    .optional()
    .describe(
      "PARSE_STATEMENT results including statement type, tokens, and parsing details. Empty array indicates invalid SQL.",
    ),
  rowCount: z.number().optional().describe("Number of result rows returned."),
  executionTime: z
    .number()
    .optional()
    .describe("Validation execution time in milliseconds."),
  objectValidation: ObjectValidationSchema.optional().describe(
    "Cross-reference results of parsed table/column names against the system catalog.",
  ),
  error: z
    .object({
      code: z.string().describe("Error code"),
      message: z.string().describe("Error message"),
      details: z.record(z.unknown()).optional().describe("Error details"),
    })
    .optional()
    .describe("Error information if the validation failed."),
});

type ValidateQueryInput = z.infer<typeof ValidateQueryInputSchema>;
type ValidateQueryOutput = z.infer<typeof ValidateQueryOutputSchema>;

// =============================================================================
// Object Reference Extraction
// =============================================================================

function extractObjectReferences(parseResults: Record<string, unknown>[]): {
  tables: TableRef[];
  columns: ColumnRef[];
} {
  const tableMap = new Map<string, TableRef>();
  const columns: ColumnRef[] = [];

  for (const row of parseResults) {
    const nameType = row.NAME_TYPE as string | null;

    if (nameType === "TABLE") {
      const schema = row.SCHEMA as string | null;
      const name = row.NAME as string | null;
      if (schema && name) {
        const key = `${schema}.${name}`;
        if (!tableMap.has(key)) {
          tableMap.set(key, { schema, name });
        }
      }
    } else if (nameType === "COLUMN") {
      const columnName = row.COLUMN_NAME as string | null;
      if (columnName) {
        const schema = row.SCHEMA as string | null;
        const tableName = row.NAME as string | null;
        columns.push({
          columnName,
          ...(schema ? { schema } : {}),
          ...(tableName ? { tableName } : {}),
        });
      }
    }
  }

  return { tables: [...tableMap.values()], columns };
}

// =============================================================================
// Catalog Cross-Reference
// =============================================================================

async function validateTables(
  tables: TableRef[],
  context: RequestContext,
): Promise<{ existingTables: Set<string>; validation: ObjectValidation["tables"] }> {
  if (tables.length === 0) {
    return { existingTables: new Set(), validation: { valid: [], invalid: [] } };
  }

  const valuesPlaceholders = tables.map(() => "(?, ?)").join(", ");
  const params = tables.flatMap((t) => [t.schema, t.name]);

  const sql = `SELECT TABLE_SCHEMA, TABLE_NAME FROM QSYS2.SYSTABLES WHERE (TABLE_SCHEMA, TABLE_NAME) IN (VALUES ${valuesPlaceholders})`;

  const result = await IBMiConnectionPool.executeQuery(sql, params, context);
  const rows = (result.data as Record<string, unknown>[]) ?? [];

  const existingTables = new Set(
    rows.map(
      (r) => `${r.TABLE_SCHEMA as string}.${r.TABLE_NAME as string}`,
    ),
  );

  const valid: string[] = [];
  const invalid: string[] = [];

  for (const table of tables) {
    const key = `${table.schema}.${table.name}`;
    if (existingTables.has(key)) {
      valid.push(key);
    } else {
      invalid.push(key);
    }
  }

  return { existingTables, validation: { valid, invalid } };
}

async function validateColumns(
  columns: ColumnRef[],
  validTables: Set<string>,
  context: RequestContext,
): Promise<ObjectValidation["columns"]> {
  if (columns.length === 0 || validTables.size === 0) {
    return { valid: [], invalid: [] };
  }

  // Build the set of (schema, table) pairs to check against
  const tablePairs = [...validTables].map((key) => {
    const dotIndex = key.indexOf(".");
    return { schema: key.substring(0, dotIndex), name: key.substring(dotIndex + 1) };
  });

  // Collect unique column names to check
  const uniqueColumnNames = [...new Set(columns.map((c) => c.columnName))];

  const tableValuesPlaceholders = tablePairs.map(() => "(?, ?)").join(", ");
  const columnPlaceholders = uniqueColumnNames.map(() => "?").join(", ");
  const params = [
    ...tablePairs.flatMap((t) => [t.schema, t.name]),
    ...uniqueColumnNames,
  ];

  const sql = `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM QSYS2.SYSCOLUMNS2 WHERE (TABLE_SCHEMA, TABLE_NAME) IN (VALUES ${tableValuesPlaceholders}) AND COLUMN_NAME IN (${columnPlaceholders})`;

  const result = await IBMiConnectionPool.executeQuery(sql, params, context);
  const rows = (result.data as Record<string, unknown>[]) ?? [];

  // Build lookup: column name → set of "SCHEMA.TABLE" where it exists
  const columnExistence = new Map<string, Set<string>>();
  for (const row of rows) {
    const colName = row.COLUMN_NAME as string;
    const tableKey = `${row.TABLE_SCHEMA as string}.${row.TABLE_NAME as string}`;
    if (!columnExistence.has(colName)) {
      columnExistence.set(colName, new Set());
    }
    columnExistence.get(colName)!.add(tableKey);
  }

  // Validate each unique column
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const colName of uniqueColumnNames) {
    const col = columns.find((c) => c.columnName === colName)!;
    const existsIn = columnExistence.get(colName);

    if (col.schema && col.tableName) {
      // Qualified column: check specific table
      const qualifiedKey = `${col.schema}.${col.tableName}`;
      if (existsIn?.has(qualifiedKey)) {
        valid.push(colName);
      } else {
        invalid.push(colName);
      }
    } else {
      // Unqualified column: check if it exists in ANY referenced valid table
      if (existsIn && existsIn.size > 0) {
        valid.push(colName);
      } else {
        invalid.push(colName);
      }
    }
  }

  return { valid, invalid };
}

// =============================================================================
// Business Logic
// =============================================================================

async function validateQueryLogic(
  params: ValidateQueryInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ValidateQueryOutput> {
  logger.debug(
    { ...appContext, toolInput: params },
    "Processing validate query logic.",
  );

  const startTime = Date.now();

  const sql = `
    SELECT *
    FROM TABLE(QSYS2.PARSE_STATEMENT(
      SQL_STATEMENT => ?,
      NAMING => '*SQL',
      DECIMAL_POINT => '*PERIOD',
      SQL_STRING_DELIMITER => '*APOSTSQL'
    )) AS P
  `.trim();

  try {
    const result = await IBMiConnectionPool.executeQuery(
      sql,
      [params.sql_statement],
      appContext,
    );

    const rawData = (result.data as Record<string, unknown>[]) ?? [];

    // Cross-reference against system catalog if parse returned results
    let objectValidation: ObjectValidation | undefined;
    if (rawData.length > 0) {
      try {
        const refs = extractObjectReferences(rawData);

        if (refs.tables.length > 0) {
          const { existingTables, validation: tableValidation } =
            await validateTables(refs.tables, appContext);

          const columnValidation = await validateColumns(
            refs.columns,
            existingTables,
            appContext,
          );

          objectValidation = {
            tables: tableValidation,
            columns: columnValidation,
          };
        }
      } catch (catalogError) {
        logger.warning(
          {
            ...appContext,
            error:
              catalogError instanceof Error
                ? catalogError.message
                : String(catalogError),
          },
          "Object validation against system catalog failed; returning parse results without cross-reference.",
        );
      }
    }

    const executionTime = Date.now() - startTime;

    // Strip null values from parse results to reduce response size
    const cleanedData = rawData.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([, v]) => v != null),
      ),
    );

    return {
      success: true,
      data: cleanedData,
      rowCount: cleanedData.length,
      executionTime,
      ...(objectValidation ? { objectValidation } : {}),
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;

    logger.error(
      {
        ...appContext,
        error: error instanceof Error ? error.message : String(error),
        sqlStatement:
          params.sql_statement.substring(0, 100) +
          (params.sql_statement.length > 100 ? "..." : ""),
        executionTime,
      },
      "Validate query failed.",
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
        code: String(JsonRpcErrorCode.DatabaseError),
        message: `Failed to validate query: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// =============================================================================
// Response Formatter
// =============================================================================

const validateQueryResponseFormatter = (
  result: ValidateQueryOutput,
): ContentBlock[] => {
  if (!result.success) {
    const errorMessage = result.error?.message || "Failed to validate query";
    const errorDetails = result.error?.details
      ? `\n\nDetails:\n${JSON.stringify(result.error.details, null, 2)}`
      : "";
    return [{ type: "text", text: `Error: ${errorMessage}${errorDetails}` }];
  }

  if (!result.data || result.data.length === 0) {
    return [
      {
        type: "text",
        text: `SQL validation failed: The statement could not be parsed. This typically indicates a syntax error.\nExecution time: ${result.executionTime}ms`,
      },
    ];
  }

  const ov = result.objectValidation;
  const invalidTables = ov?.tables.invalid ?? [];
  const invalidColumns = ov?.columns.invalid ?? [];
  const hasInvalidObjects = invalidTables.length > 0 || invalidColumns.length > 0;

  const parts: string[] = [];

  if (hasInvalidObjects) {
    parts.push("SQL validation failed: Statement references objects that do not exist.");
    const errors: string[] = [];
    if (invalidTables.length > 0) {
      errors.push(`  Tables not found: ${invalidTables.join(", ")}`);
    }
    if (invalidColumns.length > 0) {
      errors.push(`  Columns not found: ${invalidColumns.join(", ")}`);
    }
    parts.push(errors.join("\n"));
  } else {
    parts.push("SQL validation passed.");
  }

  parts.push(`Execution time: ${result.executionTime}ms`);

  const resultJson = JSON.stringify(result.data, null, 2);
  parts.push(`\nParse results:\n${resultJson}`);

  return [{ type: "text", text: parts.join("\n") }];
};

// =============================================================================
// Tool Definition
// =============================================================================

export const validateQueryTool = defineTool({
  name: "validate_query",
  title: "Validate Query",
  description:
    "Validate SQL query syntax and verify that referenced tables and columns exist in the system catalog. Uses PARSE_STATEMENT for syntax checking, then cross-references parsed object names against SYSTABLES and SYSCOLUMNS2 to detect hallucinated or incorrect table/column names.",
  inputSchema: ValidateQueryInputSchema,
  outputSchema: ValidateQueryOutputSchema,
  logic: validateQueryLogic,
  responseFormatter: validateQueryResponseFormatter,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
});
