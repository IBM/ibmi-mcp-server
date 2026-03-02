/**
 * Unit tests for default text-to-SQL toolset
 *
 * Tests the tool definitions and business logic for:
 * - list_schemas
 * - list_tables_in_schema
 * - get_table_columns
 * - validate_query
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
    const { listSchemasTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listSchemas.tool.js"
    );
    expect(listSchemasTool.name).toBe("list_schemas");
    expect(listSchemasTool.annotations?.readOnlyHint).toBe(true);
    expect(listSchemasTool.annotations?.destructiveHint).toBe(false);
  });

  it("should return schemas successfully", async () => {
    const { listSchemasTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listSchemas.tool.js"
    );

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

    const result = await listSchemasTool.logic({}, context, mockSdkContext);

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.data).toHaveLength(2);
    expect(result.data![0].SCHEMA_NAME).toBe("MYLIB");
  });

  it("should filter by schema name pattern", async () => {
    const { listSchemasTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listSchemas.tool.js"
    );

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
      { filter: "MY%" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    // Verify the filter was passed as a bind parameter
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.stringContaining("SCHEMA_NAME LIKE UPPER(?)"),
      ["MY%"],
      context,
    );
  });

  it("should exclude system schemas by default", async () => {
    const { listSchemasTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listSchemas.tool.js"
    );

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await listSchemasTool.logic({}, context, mockSdkContext);

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.stringContaining("SCHEMA_NAME NOT LIKE 'Q%'"),
      undefined,
      context,
    );
  });

  it("should include system schemas when requested", async () => {
    const { listSchemasTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listSchemas.tool.js"
    );

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await listSchemasTool.logic(
      { include_system: true },
      context,
      mockSdkContext,
    );

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.not.stringContaining("SCHEMA_NAME NOT LIKE"),
      undefined,
      context,
    );
  });

  it("should handle database errors gracefully", async () => {
    const { listSchemasTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listSchemas.tool.js"
    );

    mockExecuteQuery.mockRejectedValue(new Error("Connection failed"));

    const result = await listSchemasTool.logic({}, context, mockSdkContext);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Failed to list schemas");
    expect(result.error?.message).toContain("Connection failed");
  });

  it("should handle McpError gracefully", async () => {
    const { listSchemasTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listSchemas.tool.js"
    );

    mockExecuteQuery.mockRejectedValue(
      new McpError(JsonRpcErrorCode.DatabaseError, "DB unavailable"),
    );

    const result = await listSchemasTool.logic({}, context, mockSdkContext);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(String(JsonRpcErrorCode.DatabaseError));
    expect(result.error?.message).toBe("DB unavailable");
  });

  it("should return empty array for null data", async () => {
    const { listSchemasTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listSchemas.tool.js"
    );

    mockExecuteQuery.mockResolvedValue(createMockQueryResult(null));

    const result = await listSchemasTool.logic({}, context, mockSdkContext);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.rowCount).toBe(0);
  });
});

describe("Default Tools - list_tables_in_schema", () => {
  const context = createRequestContext();
  const mockExecuteQuery = vi.mocked(IBMiConnectionPool.executeQuery);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have correct tool metadata", async () => {
    const { listTablesInSchemaTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js"
    );
    expect(listTablesInSchemaTool.name).toBe("list_tables_in_schema");
    expect(listTablesInSchemaTool.annotations?.readOnlyHint).toBe(true);
  });

  it("should return tables for a schema", async () => {
    const { listTablesInSchemaTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js"
    );

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
      { schema_name: "QIWS" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.data![0].TABLE_NAME).toBe("QCUSTCDT");
  });

  it("should pass table_filter parameter correctly", async () => {
    const { listTablesInSchemaTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js"
    );

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await listTablesInSchemaTool.logic(
      { schema_name: "MYLIB", table_filter: "CUST%" },
      context,
      mockSdkContext,
    );

    // The table_filter is passed twice (for the *ALL check and the LIKE)
    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.any(String),
      ["MYLIB", "CUST%", "CUST%"],
      context,
    );
  });

  it("should use *ALL default for table_filter", async () => {
    const { listTablesInSchemaTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js"
    );

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    // Zod .default() applies during parse, so pass the default explicitly
    // (in production, the MCP SDK validates input before calling logic)
    await listTablesInSchemaTool.logic(
      { schema_name: "MYLIB", table_filter: "*ALL" },
      context,
      mockSdkContext,
    );

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.any(String),
      ["MYLIB", "*ALL", "*ALL"],
      context,
    );
  });

  it("should handle database errors gracefully", async () => {
    const { listTablesInSchemaTool } = await import(
      "../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js"
    );

    mockExecuteQuery.mockRejectedValue(new Error("Schema not found"));

    const result = await listTablesInSchemaTool.logic(
      { schema_name: "BADLIB" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Failed to list tables");
  });
});

describe("Default Tools - get_table_columns", () => {
  const context = createRequestContext();
  const mockExecuteQuery = vi.mocked(IBMiConnectionPool.executeQuery);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have correct tool metadata", async () => {
    const { getTableColumnsTool } = await import(
      "../../../src/ibmi-mcp-server/tools/getTableColumns.tool.js"
    );
    expect(getTableColumnsTool.name).toBe("get_table_columns");
    expect(getTableColumnsTool.annotations?.readOnlyHint).toBe(true);
  });

  it("should return columns for a table", async () => {
    const { getTableColumnsTool } = await import(
      "../../../src/ibmi-mcp-server/tools/getTableColumns.tool.js"
    );

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
    const { getTableColumnsTool } = await import(
      "../../../src/ibmi-mcp-server/tools/getTableColumns.tool.js"
    );

    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    await getTableColumnsTool.logic(
      { schema_name: "MYLIB", table_name: "MYTABLE" },
      context,
      mockSdkContext,
    );

    expect(mockExecuteQuery).toHaveBeenCalledWith(
      expect.stringContaining("QSYS2.SYSCOLUMNS"),
      ["MYLIB", "MYTABLE"],
      context,
    );
  });

  it("should return empty array for non-existent table", async () => {
    const { getTableColumnsTool } = await import(
      "../../../src/ibmi-mcp-server/tools/getTableColumns.tool.js"
    );

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
    const { getTableColumnsTool } = await import(
      "../../../src/ibmi-mcp-server/tools/getTableColumns.tool.js"
    );

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
    const { validateQueryTool } = await import(
      "../../../src/ibmi-mcp-server/tools/validateQuery.tool.js"
    );
    expect(validateQueryTool.name).toBe("validate_query");
    expect(validateQueryTool.annotations?.readOnlyHint).toBe(true);
  });

  it("should return parse results for valid SQL", async () => {
    const { validateQueryTool } = await import(
      "../../../src/ibmi-mcp-server/tools/validateQuery.tool.js"
    );

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
    const { validateQueryTool } = await import(
      "../../../src/ibmi-mcp-server/tools/validateQuery.tool.js"
    );

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
    const { validateQueryTool } = await import(
      "../../../src/ibmi-mcp-server/tools/validateQuery.tool.js"
    );

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
    const { validateQueryTool } = await import(
      "../../../src/ibmi-mcp-server/tools/validateQuery.tool.js"
    );

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
    const { validateQueryTool } = await import(
      "../../../src/ibmi-mcp-server/tools/validateQuery.tool.js"
    );

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
});

describe("Default Tools - Tool Registry", () => {
  it("should include default tools when IBMI_ENABLE_DEFAULT_TOOLS is true", async () => {
    const { allToolDefinitions } = await import(
      "../../../src/ibmi-mcp-server/tools/index.js"
    );

    const toolNames = allToolDefinitions.map((t) => t.name);
    expect(toolNames).toContain("list_schemas");
    expect(toolNames).toContain("list_tables_in_schema");
    expect(toolNames).toContain("get_table_columns");
    expect(toolNames).toContain("validate_query");
    expect(toolNames).toContain("execute_sql");
    expect(toolNames).toContain("describe_sql_object");
  });

  it("should have 6 total tools when defaults are enabled", async () => {
    const { allToolDefinitions } = await import(
      "../../../src/ibmi-mcp-server/tools/index.js"
    );

    expect(allToolDefinitions).toHaveLength(6);
  });

  it("should mark all default tools as read-only", async () => {
    const { allToolDefinitions } = await import(
      "../../../src/ibmi-mcp-server/tools/index.js"
    );

    const defaultToolNames = [
      "list_schemas",
      "list_tables_in_schema",
      "get_table_columns",
      "validate_query",
    ];

    for (const name of defaultToolNames) {
      const tool = allToolDefinitions.find((t) => t.name === name);
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
