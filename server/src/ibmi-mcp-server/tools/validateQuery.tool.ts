/**
 * Validate Query Tool
 *
 * Validates SQL query syntax using IBM i's native PARSE_STATEMENT table function,
 * then cross-references parsed table, column, function, and procedure names
 * against the system catalog (SYSTABLES / SYSCOLUMNS / SYSROUTINES) to detect
 * hallucinated object names.
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
// Types & Helpers
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

interface RoutineRef {
  schema: string;
  name: string;
}

interface ObjectValidation {
  tables: { valid: string[]; invalid: string[] };
  columns: { valid: string[]; invalid: string[] };
  routines: { valid: string[]; invalid: string[] };
}

/** Matches SQL statements that begin with a CTE (`WITH ...`). */
const CTE_REGEX = /^\s*WITH\s/i;

function qualifiedName(schema: string, name: string): string {
  return `${schema}.${name}`;
}

function stripNullValues(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v != null));
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
    invalid: z
      .array(z.string())
      .describe("Tables not found in system catalog."),
  }),
  columns: z.object({
    valid: z.array(z.string()).describe("Columns confirmed to exist."),
    invalid: z
      .array(z.string())
      .describe("Columns not found in any referenced table."),
  }),
  routines: z.object({
    valid: z
      .array(z.string())
      .describe("Functions/procedures confirmed to exist."),
    invalid: z
      .array(z.string())
      .describe("Functions/procedures not found in system catalog."),
  }),
});

const ValidateQueryOutputSchema = z.object({
  success: z
    .boolean()
    .describe("Whether the validation executed successfully."),
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
  routines: RoutineRef[];
  hasVirtualColumns: boolean;
} {
  const tableMap = new Map<string, TableRef>();
  const routineMap = new Map<string, RoutineRef>();
  const columns: ColumnRef[] = [];

  for (const row of parseResults) {
    const nameType = row.NAME_TYPE as string | null;

    if (nameType === "TABLE") {
      const schema = row.SCHEMA as string | null;
      const name = row.NAME as string | null;
      if (schema && name) {
        const key = qualifiedName(schema, name);
        if (!tableMap.has(key)) {
          tableMap.set(key, { schema, name });
        }
      }
    } else if (nameType === "COLUMN") {
      const columnName = row.COLUMN_NAME as string | null;
      if (columnName) {
        const schema = (row.SCHEMA as string | null) ?? undefined;
        const tableName = (row.NAME as string | null) ?? undefined;
        columns.push({ columnName, schema, tableName });
      }
    } else if (nameType === "FUNCTION" || nameType === "PROC") {
      const schema = row.SCHEMA as string | null;
      const name = row.NAME as string | null;
      if (schema && name) {
        const key = qualifiedName(schema, name);
        if (!routineMap.has(key)) {
          routineMap.set(key, { schema, name });
        }
      }
    }
  }

  // UDTFs produce output columns that appear as unqualified COLUMNs in
  // PARSE_STATEMENT results. These virtual columns don't exist in SYSCOLUMNS2.
  const hasVirtualColumns = routineMap.size > 0;

  return {
    tables: [...tableMap.values()],
    columns,
    routines: [...routineMap.values()],
    hasVirtualColumns,
  };
}

// =============================================================================
// Catalog Cross-Reference
// =============================================================================

async function validateTables(
  tables: TableRef[],
  context: RequestContext,
): Promise<{
  validTableRefs: TableRef[];
  validation: ObjectValidation["tables"];
}> {
  if (tables.length === 0) {
    return { validTableRefs: [], validation: { valid: [], invalid: [] } };
  }

  const valuesPlaceholders = tables.map(() => "(?, ?)").join(", ");
  const params = tables.flatMap((t) => [t.schema, t.name]);

  const sql = `SELECT TABLE_SCHEMA, TABLE_NAME FROM QSYS2.SYSTABLES WHERE (TABLE_SCHEMA, TABLE_NAME) IN (VALUES ${valuesPlaceholders})`;

  const result = await IBMiConnectionPool.executeQuery(sql, params, context);
  const rows = (result.data as Record<string, unknown>[]) ?? [];

  const existingSet = new Set(
    rows.map((r) =>
      qualifiedName(r.TABLE_SCHEMA as string, r.TABLE_NAME as string),
    ),
  );

  const valid: string[] = [];
  const invalid: string[] = [];
  const validTableRefs: TableRef[] = [];

  for (const table of tables) {
    const key = qualifiedName(table.schema, table.name);
    if (existingSet.has(key)) {
      valid.push(key);
      validTableRefs.push(table);
    } else {
      invalid.push(key);
    }
  }

  return { validTableRefs, validation: { valid, invalid } };
}

async function validateColumns(
  columns: ColumnRef[],
  validTableRefs: TableRef[],
  context: RequestContext,
): Promise<ObjectValidation["columns"]> {
  if (columns.length === 0 || validTableRefs.length === 0) {
    return { valid: [], invalid: [] };
  }

  // Collect unique column names to check
  const uniqueColumnNames = [...new Set(columns.map((c) => c.columnName))];

  const tableValuesPlaceholders = validTableRefs.map(() => "(?, ?)").join(", ");
  const columnPlaceholders = uniqueColumnNames.map(() => "?").join(", ");
  const params = [
    ...validTableRefs.flatMap((t) => [t.schema, t.name]),
    ...uniqueColumnNames,
  ];

  // Use SYSCOLUMNS (not SYSCOLUMNS2) for broader coverage of system views
  // and table-function-backed views like QSYS2.OBJECT_PRIVILEGES
  const sql = `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM QSYS2.SYSCOLUMNS WHERE (TABLE_SCHEMA, TABLE_NAME) IN (VALUES ${tableValuesPlaceholders}) AND COLUMN_NAME IN (${columnPlaceholders})`;

  const result = await IBMiConnectionPool.executeQuery(sql, params, context);
  const rows = (result.data as Record<string, unknown>[]) ?? [];

  // Build lookup: column name → set of "SCHEMA.TABLE" where it exists
  const columnExistence = new Map<string, Set<string>>();
  for (const row of rows) {
    const colName = row.COLUMN_NAME as string;
    const tableKey = qualifiedName(
      row.TABLE_SCHEMA as string,
      row.TABLE_NAME as string,
    );
    if (!columnExistence.has(colName)) {
      columnExistence.set(colName, new Set());
    }
    columnExistence.get(colName)!.add(tableKey);
  }

  // Validate each column reference individually, then deduplicate results.
  // A column name may appear multiple times with different qualifications
  // (e.g., A.STATUS from table1, B.STATUS from table2), so we check each
  // occurrence against its specific table.
  const validSet = new Set<string>();
  const invalidSet = new Set<string>();

  for (const col of columns) {
    const existsIn = columnExistence.get(col.columnName);

    if (col.schema && col.tableName) {
      // Qualified column: check specific table
      const key = qualifiedName(col.schema, col.tableName);
      if (existsIn?.has(key)) {
        validSet.add(col.columnName);
      } else {
        invalidSet.add(col.columnName);
      }
    } else {
      // Unqualified column: check if it exists in ANY valid table
      if (existsIn && existsIn.size > 0) {
        validSet.add(col.columnName);
      } else {
        invalidSet.add(col.columnName);
      }
    }
  }

  // A column found valid in one context takes precedence over invalid in another
  for (const name of validSet) {
    invalidSet.delete(name);
  }

  return { valid: [...validSet], invalid: [...invalidSet] };
}

async function validateRoutines(
  routines: RoutineRef[],
  context: RequestContext,
): Promise<ObjectValidation["routines"]> {
  if (routines.length === 0) {
    return { valid: [], invalid: [] };
  }

  const valuesPlaceholders = routines.map(() => "(?, ?)").join(", ");
  const params = routines.flatMap((r) => [r.schema, r.name]);

  // Use DISTINCT because a routine name may have multiple overloads in SYSROUTINES
  const sql = `SELECT DISTINCT ROUTINE_SCHEMA, ROUTINE_NAME FROM QSYS2.SYSROUTINES WHERE (ROUTINE_SCHEMA, ROUTINE_NAME) IN (VALUES ${valuesPlaceholders})`;

  const result = await IBMiConnectionPool.executeQuery(sql, params, context);
  const rows = (result.data as Record<string, unknown>[]) ?? [];

  const existingSet = new Set(
    rows.map((r) =>
      qualifiedName(r.ROUTINE_SCHEMA as string, r.ROUTINE_NAME as string),
    ),
  );

  const valid: string[] = [];
  const invalid: string[] = [];

  for (const routine of routines) {
    const key = qualifiedName(routine.schema, routine.name);
    if (existingSet.has(key)) {
      valid.push(key);
    } else {
      invalid.push(key);
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
        const hasRefs = refs.tables.length > 0 || refs.routines.length > 0;

        if (hasRefs) {
          // Table and routine validation are independent — run in parallel
          const [
            { validTableRefs, validation: tableValidation },
            routineValidation,
          ] = await Promise.all([
            validateTables(refs.tables, appContext),
            validateRoutines(refs.routines, appContext),
          ]);

          // CTE aliases and UDTF output columns appear as unqualified COLUMNs.
          // When virtual columns are possible, only validate qualified columns
          // (where PARSE_STATEMENT resolved SCHEMA + NAME to a physical table).
          const hasVirtualColumns =
            refs.hasVirtualColumns || CTE_REGEX.test(params.sql_statement);

          const columnsToValidate = hasVirtualColumns
            ? refs.columns.filter((c) => c.schema && c.tableName)
            : refs.columns;

          const columnValidation = await validateColumns(
            columnsToValidate,
            validTableRefs,
            appContext,
          );

          objectValidation = {
            tables: tableValidation,
            columns: columnValidation,
            routines: routineValidation,
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
    const cleanedData = rawData.map(stripNullValues);

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
    const errorMessage = result.error?.message ?? "Failed to validate query";
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
  const invalidRoutines = ov?.routines.invalid ?? [];

  const parts: string[] = [];

  // Tables are high-confidence: SYSTABLES has comprehensive coverage
  if (invalidTables.length > 0) {
    parts.push(
      "SQL validation failed: Statement references tables that do not exist.",
    );
    parts.push(`  Tables not found: ${invalidTables.join(", ")}`);
  } else {
    parts.push("SQL validation passed.");
  }

  // Columns and routines are advisory — system views and table functions may
  // expose columns/routines not fully cataloged in SYSCOLUMNS / SYSROUTINES
  const warnings: string[] = [];
  if (invalidRoutines.length > 0) {
    warnings.push(`  Routines not verified: ${invalidRoutines.join(", ")}`);
  }
  if (invalidColumns.length > 0) {
    warnings.push(`  Columns not verified: ${invalidColumns.join(", ")}`);
  }
  if (warnings.length > 0) {
    parts.push(
      "Note: The following references could not be verified against the system catalog. They may still be valid (e.g., system view columns, CTE aliases, UDTF outputs).",
    );
    parts.push(warnings.join("\n"));
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
    "Validate SQL query syntax and verify that referenced tables, columns, functions, and procedures exist in the system catalog. Uses PARSE_STATEMENT for syntax checking, then cross-references parsed object names against SYSTABLES, SYSCOLUMNS, and SYSROUTINES to detect hallucinated or incorrect object names.",
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
