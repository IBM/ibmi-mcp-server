/**
 * Unit tests for default text-to-SQL toolset
 *
 * Tests the tool definitions and business logic for:
 * - list_schemas
 * - list_tables_in_schema
 * - get_table_columns
 * - validate_query
 * - get_related_objects
 *
 * Also tests the config flag behavior for IBMI_ENABLE_DEFAULT_TOOLS.
 *
 * @module tests/unit/tools/defaultTools.test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../../src/types-global/errors.js";
import { createRequestContext } from "../../../src/utils/internal/requestContext.js";
import type { QueryResult } from "@ibm/mapepire-js";

// Mock the IBMiConnectionPool before importing the modules
vi.mock("../../../src/ibmi-mcp-server/services/connectionPool.js", () => ({
  IBMiConnectionPool: {
    executeQuery: vi.fn(),
    executeQueryWithPagination: vi.fn(),
  },
}));

// Mock the logger
vi.mock("../../../src/utils/internal/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config for tests — must include all fields accessed by transitive imports
vi.mock("../../../src/config/index.js", () => ({
  config: {
    ibmi_enableDefaultTools: true,
    ibmi_enableExecuteSql: false,
    ibmi_executeSqlReadonly: true,
    logLevel: "debug",
    logsPath: null,
    environment: "test",
    mcpServerName: "test-server",
    mcpServerVersion: "0.0.0",
    rateLimit: {
      enabled: false,
      maxRequests: 100,
      windowMs: 900_000,
      skipInDevelopment: true,
    },
    openTelemetry: {
      enabled: false,
    },
  },
}));

import { IBMiConnectionPool } from "../../../src/ibmi-mcp-server/services/connectionPool.js";

// Helper to create mock QueryResult objects
function createMockQueryResult<T = unknown>(
  data: T[] | null | undefined,
  options?: {
    success?: boolean;
    sql_rc?: number;
    execution_time?: number;
  },
): QueryResult<T> {
  return {
    success: options?.success ?? true,
    data: data as T[],
    metadata: { column_count: 0, columns: [], job: "" },
    has_results: (data && data.length > 0) ?? false,
    update_count: 0,
    id: "mock-query-id",
    is_done: true,
    sql_rc: options?.sql_rc ?? 0,
    sql_state: "00000",
    execution_time: options?.execution_time ?? 0,
  } as QueryResult<T>;
}

// Create a mock SdkContext for tool logic calls
const mockSdkContext = {
  signal: new AbortController().signal,
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
  authInfo: undefined,
  sessionId: undefined,
} as unknown as Parameters<
  typeof import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js").listSchemasTool.logic
>[2];

describe("Default Tools - list_schemas", () => {
  const context = createRequestContext();
  const mockExecuteQuery = vi.mocked(IBMiConnectionPool.executeQuery);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have correct tool metadata", async () => {
    const { listSchemasTool } =
      await import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js");
    expect(listSchemasTool.name).toBe("list_schemas");
    expect(listSchemasTool.annotations?.readOnlyHint).toBe(true);
    expect(listSchemasTool.annotations?.destructiveHint).toBe(false);
  });

  it("should return schemas successfully", async () => {
    const { listSchemasTool } =
      await import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js");

    const mockData = [
      {
        SCHEMA_NAME: "MYLIB",
        SCHEMA_TEXT: "My library",
        SYSTEM_SCHEMA_NAME: "MYLIB",
        SCHEMA_SIZE: 1024,
      },
      {
        SCHEMA_NAME: "DEVLIB",
        SCHEMA_TEXT: "Dev library",
        SYSTEM_SCHEMA_NAME: "DEVLIB",
        SCHEMA_SIZE: 2048,
      },
    ];

    mockExecuteQuery.mockResolvedValue(createMockQueryResult(mockData));

    const result = await listSchemasTool.logic(
      { limit: 50, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.data).toHaveLength(2);
    expect(result.data![0].SCHEMA_NAME).toBe("MYLIB");
    expect(result.hasMore).toBe(false);
  });

  it("should filter by schema name pattern", async () => {
    const { listSchemasTool } =
      await import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js");

    mockExecuteQuery.mockResolvedValue(
      createMockQueryResult([
        {
          SCHEMA_NAME: "MYLIB",
          SCHEMA_TEXT: "My library",
          SYSTEM_SCHEMA_NAME: "MYLIB",
          SCHEMA_SIZE: 1024,
        },
      ]),
    );

    const result = await listSchemasTool.logic(
      { filter: "MY%", limit: 50, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    // Verify the filter was passed as a bind parameter (with pagination params appended)
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.stringContaining("SCHEMA_NAME LIKE UPPER(?)"),
      ["MY%", 0, 51],
      context,
    );
  });

  it("should exclude system schemas by default", async () => {
    const { listSchemasTool } =
      await import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await listSchemasTool.logic(
      { limit: 50, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.stringContaining("SCHEMA_NAME NOT LIKE 'Q%'"),
      [0, 51],
      context,
    );
  });

  it("should include system schemas when requested", async () => {
    const { listSchemasTool } =
      await import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await listSchemasTool.logic(
      { include_system: true, limit: 50, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.not.stringContaining("SCHEMA_NAME NOT LIKE"),
      [0, 51],
      context,
    );
  });

  it("should handle database errors gracefully", async () => {
    const { listSchemasTool } =
      await import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js");

    mockExecuteQuery.mockRejectedValue(new Error("Connection failed"));

    const result = await listSchemasTool.logic(
      { limit: 50, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Failed to list schemas");
    expect(result.error?.message).toContain("Connection failed");
  });

  it("should handle McpError gracefully", async () => {
    const { listSchemasTool } =
      await import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js");

    mockExecuteQuery.mockRejectedValue(
      new McpError(JsonRpcErrorCode.DatabaseError, "DB unavailable"),
    );

    const result = await listSchemasTool.logic(
      { limit: 50, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(String(JsonRpcErrorCode.DatabaseError));
    expect(result.error?.message).toBe("DB unavailable");
  });

  it("should return empty array for null data", async () => {
    const { listSchemasTool } =
      await import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult(null));

    const result = await listSchemasTool.logic(
      { limit: 50, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("should return hasMore: true when results exceed limit", async () => {
    const { listSchemasTool } =
      await import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js");

    // Mock returns 3 rows for limit=2 (limit+1 detection)
    const mockData = [
      {
        SCHEMA_NAME: "LIB1",
        SCHEMA_TEXT: "",
        SYSTEM_SCHEMA_NAME: "LIB1",
        SCHEMA_SIZE: 0,
      },
      {
        SCHEMA_NAME: "LIB2",
        SCHEMA_TEXT: "",
        SYSTEM_SCHEMA_NAME: "LIB2",
        SCHEMA_SIZE: 0,
      },
      {
        SCHEMA_NAME: "LIB3",
        SCHEMA_TEXT: "",
        SYSTEM_SCHEMA_NAME: "LIB3",
        SCHEMA_SIZE: 0,
      },
    ];
    mockExecuteQuery.mockResolvedValue(createMockQueryResult(mockData));

    const result = await listSchemasTool.logic(
      { limit: 2, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.data).toHaveLength(2); // Extra row trimmed
    expect(result.rowCount).toBe(2);
    expect(result.limit).toBe(2);
    expect(result.offset).toBe(0);
  });

  it("should return hasMore: false when results are within limit", async () => {
    const { listSchemasTool } =
      await import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js");

    const mockData = [
      {
        SCHEMA_NAME: "LIB1",
        SCHEMA_TEXT: "",
        SYSTEM_SCHEMA_NAME: "LIB1",
        SCHEMA_SIZE: 0,
      },
    ];
    mockExecuteQuery.mockResolvedValue(createMockQueryResult(mockData));

    const result = await listSchemasTool.logic(
      { limit: 5, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.hasMore).toBe(false);
    expect(result.data).toHaveLength(1);
    expect(result.limit).toBe(5);
    expect(result.offset).toBe(0);
  });

  it("should pass custom limit and offset as bind parameters", async () => {
    const { listSchemasTool } =
      await import("../../../src/ibmi-mcp-server/tools/listSchemas.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await listSchemasTool.logic(
      { limit: 10, offset: 20 },
      context,
      mockSdkContext,
    );

    // Bind params: [offset, fetchLimit] where fetchLimit = limit + 1
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.stringContaining("OFFSET ? ROWS FETCH FIRST ? ROWS ONLY"),
      [20, 11],
      context,
    );
  });
});

describe("Default Tools - list_tables_in_schema", () => {
  const context = createRequestContext();
  const mockExecuteQuery = vi.mocked(IBMiConnectionPool.executeQuery);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have correct tool metadata", async () => {
    const { listTablesInSchemaTool } =
      await import("../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js");
    expect(listTablesInSchemaTool.name).toBe("list_tables_in_schema");
    expect(listTablesInSchemaTool.annotations?.readOnlyHint).toBe(true);
  });

  it("should return tables for a schema", async () => {
    const { listTablesInSchemaTool } =
      await import("../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js");

    const mockData = [
      {
        TABLE_SCHEMA: "QIWS",
        TABLE_NAME: "QCUSTCDT",
        TABLE_TYPE: "T",
        TABLE_TEXT: "Customer file",
        NUMBER_ROWS: 100,
        COLUMN_COUNT: 12,
      },
      {
        TABLE_SCHEMA: "QIWS",
        TABLE_NAME: "QORDER",
        TABLE_TYPE: "T",
        TABLE_TEXT: "Order file",
        NUMBER_ROWS: 500,
        COLUMN_COUNT: 8,
      },
    ];

    mockExecuteQuery.mockResolvedValue(createMockQueryResult(mockData));

    const result = await listTablesInSchemaTool.logic(
      { schema_name: "QIWS", limit: 50, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.data![0].TABLE_NAME).toBe("QCUSTCDT");
    expect(result.hasMore).toBe(false);
  });

  it("should pass table_filter parameter correctly", async () => {
    const { listTablesInSchemaTool } =
      await import("../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await listTablesInSchemaTool.logic(
      { schema_name: "MYLIB", table_filter: "CUST%", limit: 50, offset: 0 },
      context,
      mockSdkContext,
    );

    // The table_filter is passed twice (for the *ALL check and the LIKE), plus pagination params
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.any(String),
      ["MYLIB", "CUST%", "CUST%", 0, 51],
      context,
    );
  });

  it("should use *ALL default for table_filter", async () => {
    const { listTablesInSchemaTool } =
      await import("../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    // Zod .default() applies during parse, so pass the default explicitly
    // (in production, the MCP SDK validates input before calling logic)
    await listTablesInSchemaTool.logic(
      { schema_name: "MYLIB", table_filter: "*ALL", limit: 50, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.any(String),
      ["MYLIB", "*ALL", "*ALL", 0, 51],
      context,
    );
  });

  it("should handle database errors gracefully", async () => {
    const { listTablesInSchemaTool } =
      await import("../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js");

    mockExecuteQuery.mockRejectedValue(new Error("Schema not found"));

    const result = await listTablesInSchemaTool.logic(
      { schema_name: "BADLIB", limit: 50, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Failed to list tables");
  });

  it("should return hasMore: true when results exceed limit", async () => {
    const { listTablesInSchemaTool } =
      await import("../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js");

    // Mock returns 4 rows for limit=3 (limit+1 detection)
    const mockData = [
      {
        TABLE_SCHEMA: "MYLIB",
        TABLE_NAME: "T1",
        TABLE_TYPE: "T",
        TABLE_TEXT: "",
        NUMBER_ROWS: 10,
        COLUMN_COUNT: 3,
      },
      {
        TABLE_SCHEMA: "MYLIB",
        TABLE_NAME: "T2",
        TABLE_TYPE: "T",
        TABLE_TEXT: "",
        NUMBER_ROWS: 20,
        COLUMN_COUNT: 5,
      },
      {
        TABLE_SCHEMA: "MYLIB",
        TABLE_NAME: "T3",
        TABLE_TYPE: "T",
        TABLE_TEXT: "",
        NUMBER_ROWS: 30,
        COLUMN_COUNT: 4,
      },
      {
        TABLE_SCHEMA: "MYLIB",
        TABLE_NAME: "T4",
        TABLE_TYPE: "T",
        TABLE_TEXT: "",
        NUMBER_ROWS: 40,
        COLUMN_COUNT: 6,
      },
    ];
    mockExecuteQuery.mockResolvedValue(createMockQueryResult(mockData));

    const result = await listTablesInSchemaTool.logic(
      { schema_name: "MYLIB", table_filter: "*ALL", limit: 3, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.data).toHaveLength(3); // Extra row trimmed
    expect(result.rowCount).toBe(3);
    expect(result.limit).toBe(3);
    expect(result.offset).toBe(0);
  });

  it("should return hasMore: false when results are within limit", async () => {
    const { listTablesInSchemaTool } =
      await import("../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js");

    const mockData = [
      {
        TABLE_SCHEMA: "MYLIB",
        TABLE_NAME: "T1",
        TABLE_TYPE: "T",
        TABLE_TEXT: "",
        NUMBER_ROWS: 10,
        COLUMN_COUNT: 3,
      },
    ];
    mockExecuteQuery.mockResolvedValue(createMockQueryResult(mockData));

    const result = await listTablesInSchemaTool.logic(
      { schema_name: "MYLIB", table_filter: "*ALL", limit: 10, offset: 0 },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.hasMore).toBe(false);
    expect(result.data).toHaveLength(1);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it("should pass custom limit and offset as bind parameters", async () => {
    const { listTablesInSchemaTool } =
      await import("../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await listTablesInSchemaTool.logic(
      { schema_name: "MYLIB", table_filter: "*ALL", limit: 25, offset: 50 },
      context,
      mockSdkContext,
    );

    // Bind params: [schema, filter, filter, offset, fetchLimit]
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.stringContaining("OFFSET ? ROWS FETCH FIRST ? ROWS ONLY"),
      ["MYLIB", "*ALL", "*ALL", 50, 26],
      context,
    );
  });
});

describe("Default Tools - get_table_columns", () => {
  const context = createRequestContext();
  const mockExecuteQuery = vi.mocked(IBMiConnectionPool.executeQuery);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have correct tool metadata", async () => {
    const { getTableColumnsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getTableColumns.tool.js");
    expect(getTableColumnsTool.name).toBe("get_table_columns");
    expect(getTableColumnsTool.annotations?.readOnlyHint).toBe(true);
  });

  it("should return columns for a table", async () => {
    const { getTableColumnsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getTableColumns.tool.js");

    const mockData = [
      {
        COLUMN_NAME: "CUSNUM",
        DATA_TYPE: "DECIMAL",
        LENGTH: 6,
        NUMERIC_SCALE: 0,
        IS_NULLABLE: "N",
        HAS_DEFAULT: "N",
        COLUMN_DEFAULT: null,
        COLUMN_TEXT: "Customer number",
        ORDINAL_POSITION: 1,
        CCSID: 0,
      },
      {
        COLUMN_NAME: "LSTNAM",
        DATA_TYPE: "CHAR",
        LENGTH: 8,
        NUMERIC_SCALE: null,
        IS_NULLABLE: "Y",
        HAS_DEFAULT: "N",
        COLUMN_DEFAULT: null,
        COLUMN_TEXT: "Last name",
        ORDINAL_POSITION: 2,
        CCSID: 37,
      },
    ];

    mockExecuteQuery.mockResolvedValue(createMockQueryResult(mockData));

    const result = await getTableColumnsTool.logic(
      { schema_name: "QIWS", table_name: "QCUSTCDT" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.data![0].COLUMN_NAME).toBe("CUSNUM");
    expect(result.data![1].DATA_TYPE).toBe("CHAR");
  });

  it("should pass schema and table as bind parameters", async () => {
    const { getTableColumnsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getTableColumns.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await getTableColumnsTool.logic(
      { schema_name: "MYLIB", table_name: "MYTABLE" },
      context,
      mockSdkContext,
    );

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.stringContaining("QSYS2.SYSCOLUMNS2"),
      ["MYLIB", "MYTABLE"],
      context,
    );
  });

  it("should return empty array for non-existent table", async () => {
    const { getTableColumnsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getTableColumns.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    const result = await getTableColumnsTool.logic(
      { schema_name: "MYLIB", table_name: "NONEXISTENT" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("should handle database errors gracefully", async () => {
    const { getTableColumnsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getTableColumns.tool.js");

    mockExecuteQuery.mockRejectedValue(new Error("Authorization failure"));

    const result = await getTableColumnsTool.logic(
      { schema_name: "RESTRICTED", table_name: "SECRET" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Failed to get table columns");
  });
});

describe("Default Tools - validate_query", () => {
  const context = createRequestContext();
  const mockExecuteQuery = vi.mocked(IBMiConnectionPool.executeQuery);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have correct tool metadata", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");
    expect(validateQueryTool.name).toBe("validate_query");
    expect(validateQueryTool.annotations?.readOnlyHint).toBe(true);
  });

  it("should return parse results for valid SQL", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    const mockData = [
      {
        SQL_STATEMENT_TYPE: "QUERY",
        SQL_STATEMENT_TEXT: "SELECT * FROM QIWS.QCUSTCDT",
      },
    ];

    mockExecuteQuery.mockResolvedValue(createMockQueryResult(mockData));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECT * FROM QIWS.QCUSTCDT" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.data![0]).toHaveProperty("SQL_STATEMENT_TYPE", "QUERY");
  });

  it("should call PARSE_STATEMENT with correct parameters", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await validateQueryTool.logic(
      { sql_statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1" },
      context,
      mockSdkContext,
    );

    const callArgs = mockExecuteQuery.mock.calls[0];
    expect(callArgs[0]).toContain("PARSE_STATEMENT");
    expect(callArgs[0]).toContain("SQL_STATEMENT =>");
    expect(callArgs[0]).toContain("NAMING => '*SQL'");
    expect(callArgs[1]).toEqual(["SELECT 1 FROM SYSIBM.SYSDUMMY1"]);
  });

  it("should return empty data for invalid SQL (syntax error)", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECTT * FROMM invalid" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("should handle database errors gracefully", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    mockExecuteQuery.mockRejectedValue(new Error("Connection timeout"));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECT * FROM test" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Failed to validate query");
  });

  it("should handle null data in result", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult(null));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECT * FROM test" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("should cross-reference valid tables and columns against system catalog", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    // 1st call: PARSE_STATEMENT returns table + column refs
    const parseData = [
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "CUSNUM",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "LSTNAM",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "TABLE",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    // 2nd call: SYSTABLES confirms the table exists
    const tablesData = [{ TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT" }];
    // 3rd call: SYSCOLUMNS2 confirms both columns exist
    const columnsData = [
      { TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT", COLUMN_NAME: "CUSNUM" },
      { TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT", COLUMN_NAME: "LSTNAM" },
    ];

    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult(tablesData))
      .mockResolvedValueOnce(createMockQueryResult(columnsData));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECT CUSNUM, LSTNAM FROM QIWS.QCUSTCDT" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.objectValidation).toBeDefined();
    expect(result.objectValidation!.tables.valid).toEqual(["QIWS.QCUSTCDT"]);
    expect(result.objectValidation!.tables.invalid).toEqual([]);
    expect(result.objectValidation!.columns.valid).toContain("CUSNUM");
    expect(result.objectValidation!.columns.valid).toContain("LSTNAM");
    expect(result.objectValidation!.columns.invalid).toEqual([]);
    expect(result.objectValidation!.routines.valid).toEqual([]);
    expect(result.objectValidation!.routines.invalid).toEqual([]);
  });

  it("should detect hallucinated table names", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    const parseData = [
      {
        NAME_TYPE: "TABLE",
        NAME: "FAKE_TABLE",
        SCHEMA: "QIWS",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    // SYSTABLES returns empty — table doesn't exist
    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult([]));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECT * FROM QIWS.FAKE_TABLE" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.objectValidation).toBeDefined();
    expect(result.objectValidation!.tables.invalid).toEqual([
      "QIWS.FAKE_TABLE",
    ]);
    expect(result.objectValidation!.tables.valid).toEqual([]);
    // No column validation when no valid tables exist
    expect(result.objectValidation!.columns.valid).toEqual([]);
    expect(result.objectValidation!.columns.invalid).toEqual([]);
    expect(result.objectValidation!.routines.valid).toEqual([]);
    expect(result.objectValidation!.routines.invalid).toEqual([]);
  });

  it("should detect hallucinated column names", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    const parseData = [
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "CUSNUM",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "FAKE_COL",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "TABLE",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    const tablesData = [{ TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT" }];
    // SYSCOLUMNS2 only returns CUSNUM, not FAKE_COL
    const columnsData = [
      { TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT", COLUMN_NAME: "CUSNUM" },
    ];

    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult(tablesData))
      .mockResolvedValueOnce(createMockQueryResult(columnsData));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECT CUSNUM, FAKE_COL FROM QIWS.QCUSTCDT" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.objectValidation!.columns.valid).toContain("CUSNUM");
    expect(result.objectValidation!.columns.invalid).toContain("FAKE_COL");
    expect(result.objectValidation!.routines.valid).toEqual([]);
    expect(result.objectValidation!.routines.invalid).toEqual([]);
  });

  it("should resolve qualified columns against their specific table", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    // Aliased columns have SCHEMA and NAME populated
    const parseData = [
      {
        NAME_TYPE: "COLUMN",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: "CUSNUM",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "TABLE",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    const tablesData = [{ TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT" }];
    const columnsData = [
      { TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT", COLUMN_NAME: "CUSNUM" },
    ];

    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult(tablesData))
      .mockResolvedValueOnce(createMockQueryResult(columnsData));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECT A.CUSNUM FROM QIWS.QCUSTCDT A" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.objectValidation!.columns.valid).toContain("CUSNUM");
    expect(result.objectValidation!.columns.invalid).toEqual([]);
    expect(result.objectValidation!.routines.valid).toEqual([]);
    expect(result.objectValidation!.routines.invalid).toEqual([]);
  });

  it("should skip object validation when no schema-qualified tables exist", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    // TABLE row without SCHEMA (unqualified)
    const parseData = [
      {
        NAME_TYPE: "TABLE",
        NAME: "SOMETABLE",
        SCHEMA: null,
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];

    mockExecuteQuery.mockResolvedValueOnce(createMockQueryResult(parseData));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECT * FROM SOMETABLE" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    // Only one executeQuery call (PARSE_STATEMENT) — no catalog queries
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    expect(result.objectValidation).toBeUndefined();
  });

  it("should handle SELECT * with no column references gracefully", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    // SELECT * returns only TABLE row, no COLUMN rows
    const parseData = [
      {
        NAME_TYPE: "TABLE",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    const tablesData = [{ TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT" }];

    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult(tablesData));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECT * FROM QIWS.QCUSTCDT" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.objectValidation).toBeDefined();
    expect(result.objectValidation!.tables.valid).toEqual(["QIWS.QCUSTCDT"]);
    // No column validation needed (no columns to check)
    expect(result.objectValidation!.columns.valid).toEqual([]);
    expect(result.objectValidation!.columns.invalid).toEqual([]);
    expect(result.objectValidation!.routines.valid).toEqual([]);
    expect(result.objectValidation!.routines.invalid).toEqual([]);
    // Only 2 calls: PARSE_STATEMENT + SYSTABLES (no SYSCOLUMNS2)
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
  });

  it("should gracefully degrade when catalog query fails", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    const parseData = [
      {
        NAME_TYPE: "TABLE",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];

    // PARSE_STATEMENT succeeds, but SYSTABLES query fails
    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockRejectedValueOnce(new Error("Catalog query timeout"));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECT * FROM QIWS.QCUSTCDT" },
      context,
      mockSdkContext,
    );

    // Still succeeds with parse data (nulls stripped), just no objectValidation
    expect(result.success).toBe(true);
    expect(result.data).toEqual([
      {
        NAME_TYPE: "TABLE",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ]);
    expect(result.objectValidation).toBeUndefined();
  });

  it("should validate functions against SYSROUTINES", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    const parseData = [
      {
        NAME_TYPE: "FUNCTION",
        NAME: "OBJECT_STATISTICS",
        SCHEMA: "QSYS2",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "TABLE",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    const tablesData = [{ TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT" }];
    const routinesData = [
      { ROUTINE_SCHEMA: "QSYS2", ROUTINE_NAME: "OBJECT_STATISTICS" },
    ];

    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult(tablesData))
      .mockResolvedValueOnce(createMockQueryResult(routinesData));

    const result = await validateQueryTool.logic(
      {
        sql_statement:
          "SELECT * FROM TABLE(QSYS2.OBJECT_STATISTICS('QIWS', '*ALL', '*ALLSIMPLE'))",
      },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.objectValidation!.routines.valid).toEqual([
      "QSYS2.OBJECT_STATISTICS",
    ]);
    expect(result.objectValidation!.routines.invalid).toEqual([]);
  });

  it("should detect hallucinated function names", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    const parseData = [
      {
        NAME_TYPE: "FUNCTION",
        NAME: "FAKE_FUNCTION",
        SCHEMA: "QSYS2",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "TABLE",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    const tablesData = [{ TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT" }];
    // SYSROUTINES returns empty — function doesn't exist
    const routinesData: Record<string, unknown>[] = [];

    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult(tablesData))
      .mockResolvedValueOnce(createMockQueryResult(routinesData));

    const result = await validateQueryTool.logic(
      { sql_statement: "SELECT * FROM TABLE(QSYS2.FAKE_FUNCTION('QIWS'))" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.objectValidation!.routines.invalid).toEqual([
      "QSYS2.FAKE_FUNCTION",
    ]);
    expect(result.objectValidation!.routines.valid).toEqual([]);
  });

  it("should validate stored procedures against SYSROUTINES", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    const parseData = [
      {
        NAME_TYPE: "PROC",
        NAME: "GENERATE_SQL",
        SCHEMA: "QSYS2",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "CALL",
      },
    ];
    const routinesData = [
      { ROUTINE_SCHEMA: "QSYS2", ROUTINE_NAME: "GENERATE_SQL" },
    ];

    // No SYSTABLES query — validateTables([]) returns early with empty tables
    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult(routinesData));

    const result = await validateQueryTool.logic(
      { sql_statement: "CALL QSYS2.GENERATE_SQL('QIWS', 'QCUSTCDT', 'TABLE')" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.objectValidation!.routines.valid).toEqual([
      "QSYS2.GENERATE_SQL",
    ]);
    expect(result.objectValidation!.routines.invalid).toEqual([]);
  });

  it("should skip unqualified column validation for UDTF queries", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    // UDTF output columns appear as unqualified COLUMNs (SCHEMA=null, NAME=null)
    const parseData = [
      {
        NAME_TYPE: "FUNCTION",
        NAME: "OBJECT_STATISTICS",
        SCHEMA: "QSYS2",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "OBJNAME",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "OBJSIZE",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    const routinesData = [
      { ROUTINE_SCHEMA: "QSYS2", ROUTINE_NAME: "OBJECT_STATISTICS" },
    ];

    // No SYSTABLES query — validateTables([]) returns early. No SYSCOLUMNS2 — unqualified columns skipped.
    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult(routinesData));

    const result = await validateQueryTool.logic(
      {
        sql_statement:
          "SELECT OBJNAME, OBJSIZE FROM TABLE(QSYS2.OBJECT_STATISTICS('QIWS', '*ALL', '*ALLSIMPLE'))",
      },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.objectValidation!.routines.valid).toEqual([
      "QSYS2.OBJECT_STATISTICS",
    ]);
    // Unqualified UDTF output columns should NOT be flagged as invalid
    expect(result.objectValidation!.columns.invalid).toEqual([]);
    // They should be reported as skipped so callers know they weren't verified
    expect(result.objectValidation!.columns.skipped).toEqual([
      "OBJNAME",
      "OBJSIZE",
    ]);
  });

  it("should report bogus UDTF column names as skipped", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    // Simulates a query with a typo in a UDTF output column name
    // e.g., ENTRY_TIMESTAMPdsadasdas instead of ENTRY_TIMESTAMP
    const parseData = [
      {
        NAME_TYPE: "FUNCTION",
        NAME: "AUDIT_JOURNAL_CP",
        SCHEMA: "SYSTOOLS",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "ENTRY_TIMESTAMPdsadasdas",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "USER_NAME",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "CHANGED_PROFILE",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    const routinesData = [
      { ROUTINE_SCHEMA: "SYSTOOLS", ROUTINE_NAME: "AUDIT_JOURNAL_CP" },
    ];

    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult(routinesData));

    const result = await validateQueryTool.logic(
      {
        sql_statement:
          "SELECT ENTRY_TIMESTAMPdsadasdas, USER_NAME, CHANGED_PROFILE FROM TABLE(SYSTOOLS.AUDIT_JOURNAL_CP(STARTING_TIMESTAMP => CURRENT_TIMESTAMP - 180 DAYS))",
      },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.objectValidation!.routines.valid).toEqual([
      "SYSTOOLS.AUDIT_JOURNAL_CP",
    ]);
    // No columns should be invalid (they're skipped, not validated)
    expect(result.objectValidation!.columns.invalid).toEqual([]);
    // All unqualified UDTF columns — including the bogus one — should be skipped
    expect(result.objectValidation!.columns.skipped).toContain(
      "ENTRY_TIMESTAMPdsadasdas",
    );
    expect(result.objectValidation!.columns.skipped).toContain("USER_NAME");
    expect(result.objectValidation!.columns.skipped).toContain(
      "CHANGED_PROFILE",
    );
  });

  it("should skip unqualified column validation for CTE queries", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    // CTE aliases appear as unqualified COLUMNs
    const parseData = [
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "LIB_NAME",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "OBJ_TYPE",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "TABLE",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    const tablesData = [{ TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT" }];

    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult(tablesData));
    // No SYSCOLUMNS2 call — unqualified columns skipped due to CTE

    const result = await validateQueryTool.logic(
      {
        sql_statement:
          "WITH cte(LIB_NAME, OBJ_TYPE) AS (SELECT LSTNAM, CUSNUM FROM QIWS.QCUSTCDT) SELECT * FROM cte",
      },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    // Unqualified CTE alias columns should NOT be flagged as invalid
    expect(result.objectValidation!.columns.invalid).toEqual([]);
    expect(result.objectValidation!.routines.valid).toEqual([]);
    expect(result.objectValidation!.routines.invalid).toEqual([]);
  });

  it("should still validate qualified columns when virtual columns are present", async () => {
    const { validateQueryTool } =
      await import("../../../src/ibmi-mcp-server/tools/validateQuery.tool.js");

    // Mix of qualified columns (from a real table) and unqualified UDTF output columns
    const parseData = [
      {
        NAME_TYPE: "FUNCTION",
        NAME: "OBJECT_STATISTICS",
        SCHEMA: "QSYS2",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "COLUMN",
        NAME: null,
        SCHEMA: null,
        COLUMN_NAME: "OBJNAME",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "COLUMN",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: "CUSNUM",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "COLUMN",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: "FAKE_COL",
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
      {
        NAME_TYPE: "TABLE",
        NAME: "QCUSTCDT",
        SCHEMA: "QIWS",
        COLUMN_NAME: null,
        USAGE_TYPE: "QUERY",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    const tablesData = [{ TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT" }];
    const routinesData = [
      { ROUTINE_SCHEMA: "QSYS2", ROUTINE_NAME: "OBJECT_STATISTICS" },
    ];
    // SYSCOLUMNS2 returns CUSNUM but not FAKE_COL
    const columnsData = [
      { TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT", COLUMN_NAME: "CUSNUM" },
    ];

    mockExecuteQuery
      .mockResolvedValueOnce(createMockQueryResult(parseData))
      .mockResolvedValueOnce(createMockQueryResult(tablesData))
      .mockResolvedValueOnce(createMockQueryResult(routinesData))
      .mockResolvedValueOnce(createMockQueryResult(columnsData));

    const result = await validateQueryTool.logic(
      {
        sql_statement:
          "SELECT A.CUSNUM, A.FAKE_COL, OBJNAME FROM QIWS.QCUSTCDT A, TABLE(QSYS2.OBJECT_STATISTICS('QIWS', '*ALL', '*ALLSIMPLE'))",
      },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    // Qualified CUSNUM is valid
    expect(result.objectValidation!.columns.valid).toContain("CUSNUM");
    // Qualified FAKE_COL is still caught as invalid
    expect(result.objectValidation!.columns.invalid).toContain("FAKE_COL");
    // Unqualified OBJNAME (UDTF output) is NOT flagged as invalid
    expect(result.objectValidation!.columns.invalid).not.toContain("OBJNAME");
    // It should be reported as skipped instead
    expect(result.objectValidation!.columns.skipped).toContain("OBJNAME");
  });
});

describe("Default Tools - get_related_objects", () => {
  const context = createRequestContext();
  const mockExecuteQuery = vi.mocked(IBMiConnectionPool.executeQuery);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have correct tool metadata", async () => {
    const { getRelatedObjectsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getRelatedObjects.tool.js");
    expect(getRelatedObjectsTool.name).toBe("get_related_objects");
    expect(getRelatedObjectsTool.annotations?.readOnlyHint).toBe(true);
    expect(getRelatedObjectsTool.annotations?.destructiveHint).toBe(false);
  });

  it("should return dependent objects for a file", async () => {
    const { getRelatedObjectsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getRelatedObjects.tool.js");

    const mockData = [
      {
        SOURCE_SCHEMA_NAME: "APPLIB",
        SOURCE_SQL_NAME: "ORDERS",
        SQL_OBJECT_TYPE: "INDEX",
        SCHEMA_NAME: "APPLIB",
        SQL_NAME: "ORDERS_IDX1",
        LIBRARY_NAME: "APPLIB",
        SYSTEM_NAME: "ORDIDX1",
        OBJECT_OWNER: "QSECOFR",
        LONG_COMMENT: null,
        OBJECT_TEXT: "Order index",
        LAST_ALTERED: "2024-01-15T10:00:00",
      },
      {
        SOURCE_SCHEMA_NAME: "APPLIB",
        SOURCE_SQL_NAME: "ORDERS",
        SQL_OBJECT_TYPE: "VIEW",
        SCHEMA_NAME: "APPLIB",
        SQL_NAME: "ORDERS_V1",
        LIBRARY_NAME: "APPLIB",
        SYSTEM_NAME: "ORDV1",
        OBJECT_OWNER: "QSECOFR",
        LONG_COMMENT: null,
        OBJECT_TEXT: "Active orders view",
        LAST_ALTERED: "2024-02-20T14:30:00",
      },
    ];

    mockExecuteQuery.mockResolvedValue(createMockQueryResult(mockData));

    const result = await getRelatedObjectsTool.logic(
      { library_name: "APPLIB", file_name: "ORDERS" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.data![0].SQL_OBJECT_TYPE).toBe("INDEX");
    expect(result.data![1].SQL_OBJECT_TYPE).toBe("VIEW");
  });

  it("should pass library and file as bind parameters", async () => {
    const { getRelatedObjectsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getRelatedObjects.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await getRelatedObjectsTool.logic(
      { library_name: "MYLIB", file_name: "MYTABLE" },
      context,
      mockSdkContext,
    );

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.stringContaining("SYSTOOLS.RELATED_OBJECTS"),
      ["MYLIB", "MYTABLE"],
      context,
    );
  });

  it("should filter by object_type_filter when provided", async () => {
    const { getRelatedObjectsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getRelatedObjects.tool.js");

    mockExecuteQuery.mockResolvedValue(
      createMockQueryResult([
        {
          SOURCE_SCHEMA_NAME: "APPLIB",
          SOURCE_SQL_NAME: "ORDERS",
          SQL_OBJECT_TYPE: "INDEX",
          SCHEMA_NAME: "APPLIB",
          SQL_NAME: "ORDERS_IDX1",
        },
      ]),
    );

    await getRelatedObjectsTool.logic(
      {
        library_name: "APPLIB",
        file_name: "ORDERS",
        object_type_filter: "INDEX",
      },
      context,
      mockSdkContext,
    );

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE SQL_OBJECT_TYPE = ?"),
      ["APPLIB", "ORDERS", "INDEX"],
      context,
    );
  });

  it("should not include WHERE clause when object_type_filter is omitted", async () => {
    const { getRelatedObjectsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getRelatedObjects.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await getRelatedObjectsTool.logic(
      { library_name: "APPLIB", file_name: "ORDERS" },
      context,
      mockSdkContext,
    );

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.not.stringContaining("WHERE"),
      ["APPLIB", "ORDERS"],
      context,
    );
  });

  it("should return empty array for non-existent file", async () => {
    const { getRelatedObjectsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getRelatedObjects.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    const result = await getRelatedObjectsTool.logic(
      { library_name: "MYLIB", file_name: "NONEXISTENT" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("should return empty array for null data", async () => {
    const { getRelatedObjectsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getRelatedObjects.tool.js");

    mockExecuteQuery.mockResolvedValue(createMockQueryResult(null));

    const result = await getRelatedObjectsTool.logic(
      { library_name: "MYLIB", file_name: "SOMEFILE" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("should strip null values from result rows", async () => {
    const { getRelatedObjectsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getRelatedObjects.tool.js");

    const mockData = [
      {
        SOURCE_SCHEMA_NAME: "APPLIB",
        SOURCE_SQL_NAME: "ORDERS",
        SQL_OBJECT_TYPE: "INDEX",
        SCHEMA_NAME: "APPLIB",
        SQL_NAME: "IDX1",
        LONG_COMMENT: null,
        OBJECT_TEXT: null,
      },
    ];

    mockExecuteQuery.mockResolvedValue(createMockQueryResult(mockData));

    const result = await getRelatedObjectsTool.logic(
      { library_name: "APPLIB", file_name: "ORDERS" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.data![0]).not.toHaveProperty("LONG_COMMENT");
    expect(result.data![0]).not.toHaveProperty("OBJECT_TEXT");
    expect(result.data![0].SQL_OBJECT_TYPE).toBe("INDEX");
  });

  it("should handle database errors gracefully", async () => {
    const { getRelatedObjectsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getRelatedObjects.tool.js");

    mockExecuteQuery.mockRejectedValue(new Error("Connection failed"));

    const result = await getRelatedObjectsTool.logic(
      { library_name: "BADLIB", file_name: "BADFILE" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Failed to get related objects");
    expect(result.error?.message).toContain("Connection failed");
  });

  it("should handle McpError gracefully", async () => {
    const { getRelatedObjectsTool } =
      await import("../../../src/ibmi-mcp-server/tools/getRelatedObjects.tool.js");

    mockExecuteQuery.mockRejectedValue(
      new McpError(JsonRpcErrorCode.DatabaseError, "DB unavailable"),
    );

    const result = await getRelatedObjectsTool.logic(
      { library_name: "MYLIB", file_name: "MYFILE" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(String(JsonRpcErrorCode.DatabaseError));
    expect(result.error?.message).toBe("DB unavailable");
  });
});

describe("Default Tools - Tool Registry", () => {
  it("should include default tools when IBMI_ENABLE_DEFAULT_TOOLS is true", async () => {
    const { getAllToolDefinitions } =
      await import("../../../src/ibmi-mcp-server/tools/index.js");

    const toolNames = getAllToolDefinitions().map((t) => t.name);
    expect(toolNames).toContain("list_schemas");
    expect(toolNames).toContain("list_tables_in_schema");
    expect(toolNames).toContain("get_table_columns");
    expect(toolNames).toContain("get_related_objects");
    expect(toolNames).toContain("validate_query");
    expect(toolNames).toContain("execute_sql");
    expect(toolNames).toContain("describe_sql_object");
  });

  it("should have 7 total tools when defaults are enabled", async () => {
    const { getAllToolDefinitions } =
      await import("../../../src/ibmi-mcp-server/tools/index.js");

    expect(getAllToolDefinitions()).toHaveLength(7);
  });

  it("should mark all default tools as read-only", async () => {
    const { getAllToolDefinitions } =
      await import("../../../src/ibmi-mcp-server/tools/index.js");

    const defaultToolNames = [
      "list_schemas",
      "list_tables_in_schema",
      "get_table_columns",
      "get_related_objects",
      "validate_query",
    ];

    for (const name of defaultToolNames) {
      const tool = getAllToolDefinitions().find((t) => t.name === name);
      expect(tool, `Tool ${name} should exist`).toBeDefined();
      expect(
        tool?.annotations?.readOnlyHint,
        `Tool ${name} should be readOnlyHint=true`,
      ).toBe(true);
      expect(
        tool?.annotations?.destructiveHint,
        `Tool ${name} should be destructiveHint=false`,
      ).toBe(false);
    }
  });
});
