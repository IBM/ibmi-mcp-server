/**
 * Unit tests for executeSql.tool.ts
 *
 * Drives the real execute_sql logic (executeSqlTool.logic) with a mocked
 * connection pool and checks that it:
 * - Validates SQL using IBM i's PARSE_STATEMENT before executing
 * - Enforces readonly mode restrictions
 * - Fails closed on validation errors
 * - Strips trailing semicolons before validation and execution
 *
 * @module tests/unit/tools/executeSql.tool.test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../../src/types-global/errors.js";
import { createRequestContext } from "../../../src/utils/internal/requestContext.js";

// Mock the IBMiConnectionPool before importing the module
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
    ibmi_enableDefaultTools: false,
    ibmi_enableExecuteSql: true,
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

// Now import the modules after mocks are set up
import { IBMiConnectionPool } from "../../../src/ibmi-mcp-server/services/connectionPool.js";
import {
  executeSqlTool,
  configureExecuteSqlTool,
} from "../../../src/ibmi-mcp-server/tools/executeSql.tool.js";
import type { QueryResult } from "@ibm/mapepire-js";

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

const mockSdkContext = {} as Parameters<typeof executeSqlTool.logic>[2];

describe("execute_sql - PARSE_STATEMENT Runtime Validation", () => {
  const context = createRequestContext();
  const mockExecuteQuery = vi.mocked(IBMiConnectionPool.executeQuery);
  const mockExecuteQueryWithPagination = vi.mocked(
    IBMiConnectionPool.executeQueryWithPagination,
  );

  const RESULT_ROWS = [{ CUSNUM: 1 }, { CUSNUM: 2 }];

  /** Run the real tool logic */
  const run = (sql: string) =>
    executeSqlTool.logic({ sql }, context, mockSdkContext);

  /** Statement type IBM i's PARSE_STATEMENT reports for the query */
  const mockParsedType = (statementType: string) =>
    mockExecuteQuery.mockResolvedValue(
      createMockQueryResult([{ SQL_STATEMENT_TYPE: statementType }]),
    );

  beforeEach(() => {
    vi.clearAllMocks();
    configureExecuteSqlTool({ security: { readOnly: true } });
    mockExecuteQueryWithPagination.mockResolvedValue({
      data: RESULT_ROWS,
      success: true,
      sql_rc: 0,
      execution_time: 1,
      truncated: false,
    });
  });

  describe("Read-Only Mode - Valid Queries", () => {
    it("should allow SELECT queries in readonly mode", async () => {
      // Mock successful PARSE_STATEMENT result for SELECT
      mockParsedType("QUERY");

      const result = await run("SELECT * FROM QIWS.QCUSTCDT");

      expect(result.success).toBe(true);
      expect(result.data).toEqual(RESULT_ROWS);
      expect(result.rowCount).toBe(2);

      expect(mockExecuteQuery).toHaveBeenCalledWith(
        expect.stringContaining("PARSE_STATEMENT"),
        ["SELECT * FROM QIWS.QCUSTCDT"],
        context,
      );
      expect(mockExecuteQueryWithPagination).toHaveBeenCalledWith(
        "SELECT * FROM QIWS.QCUSTCDT",
        [],
        context,
      );
    });

    it("should allow complex SELECT with CTEs in readonly mode", async () => {
      mockParsedType("QUERY");

      const complexQuery = `
        WITH sales_summary AS (
          SELECT region, SUM(amount) as total
          FROM sales
          GROUP BY region
        )
        SELECT * FROM sales_summary WHERE total > 1000
      `;

      const result = await run(complexQuery);

      expect(result.success).toBe(true);
      expect(mockExecuteQueryWithPagination).toHaveBeenCalledTimes(1);
    });

    it("should allow SELECT with UNION in readonly mode", async () => {
      mockParsedType("QUERY");

      const unionQuery = `
        SELECT name FROM employees
        UNION
        SELECT name FROM contractors
      `;

      const result = await run(unionQuery);

      expect(result.success).toBe(true);
      expect(mockExecuteQueryWithPagination).toHaveBeenCalledTimes(1);
    });
  });

  describe("Read-Only Mode - Blocked Queries", () => {
    // The statement text passes the local validator, so these cases exercise
    // the PARSE_STATEMENT layer: whatever IBM i classifies as a non-query
    // must be rejected and never executed.
    it.each(["INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "DROP", "ALTER"])(
      "should reject statements IBM i parses as %s in readonly mode",
      async (statementType) => {
        mockParsedType(statementType);

        const result = await run("SELECT * FROM QIWS.QCUSTCDT");

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(
          String(JsonRpcErrorCode.ValidationError),
        );
        expect(result.error?.message).toContain(
          `Non-query statement '${statementType}'`,
        );
        expect(result.error?.message).toContain(
          "not allowed in read-only mode",
        );
        expect(result.error?.details).toMatchObject({
          sqlStatementType: statementType,
          readOnly: true,
          validationMethod: "parse_statement",
        });
        expect(mockExecuteQueryWithPagination).not.toHaveBeenCalled();
      },
    );

    it.each([
      "INSERT INTO users (name) VALUES ('test')",
      "UPDATE users SET name = 'test' WHERE id = 1",
      "DELETE FROM users WHERE id = 1",
      "MERGE INTO target USING source ON target.id = source.id",
      "CREATE TABLE test (id INT)",
      "DROP TABLE test",
      "ALTER TABLE test ADD COLUMN name VARCHAR(50)",
    ])(
      "should reject %s before it reaches the database in readonly mode",
      async (sql) => {
        const result = await run(sql);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(
          String(JsonRpcErrorCode.ValidationError),
        );
        expect(mockExecuteQuery).not.toHaveBeenCalled();
        expect(mockExecuteQueryWithPagination).not.toHaveBeenCalled();
      },
    );
  });

  describe("Non-Read-Only Mode", () => {
    beforeEach(() => {
      configureExecuteSqlTool({ security: { readOnly: false } });
    });

    it.each([
      ["SELECT", "QUERY", "SELECT * FROM QIWS.QCUSTCDT"],
      ["INSERT", "INSERT", "INSERT INTO users (name) VALUES ('test')"],
      ["UPDATE", "UPDATE", "UPDATE users SET name = 'test' WHERE id = 1"],
      ["DELETE", "DELETE", "DELETE FROM users WHERE id = 1"],
    ])(
      "should allow %s statements in non-readonly mode",
      async (_label, statementType, sql) => {
        mockParsedType(statementType);

        const result = await run(sql);

        expect(result.success).toBe(true);
        expect(mockExecuteQueryWithPagination).toHaveBeenCalledWith(
          sql,
          [],
          context,
        );
      },
    );
  });

  describe("Syntax Error Handling", () => {
    it("should reject queries with syntax errors (empty result)", async () => {
      // Empty result from PARSE_STATEMENT indicates syntax error
      mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

      const result = await run("SELECT * FROMM invalid");

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(String(JsonRpcErrorCode.ValidationError));
      expect(result.error?.message).toContain("SQL syntax error");
      expect(result.error?.message).toContain("could not be parsed");
      expect(result.error?.details).toMatchObject({
        validationMethod: "parse_statement",
      });
      expect(mockExecuteQueryWithPagination).not.toHaveBeenCalled();
    });

    it("should reject queries with malformed SQL", async () => {
      mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

      const result = await run("INVALID SQL QUERY ;;;");

      expect(result.success).toBe(false);
      expect(mockExecuteQueryWithPagination).not.toHaveBeenCalled();
    });

    it("should truncate long queries in error messages", async () => {
      mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

      const longQuery = "SELECT * FROM table WHERE " + "x = 1 AND ".repeat(50);

      const result = await run(longQuery);

      expect(result.success).toBe(false);
      expect(result.error?.details?.query).toHaveLength(103); // 100 chars + "..."
      expect(result.error?.details?.query).toContain("...");
    });
  });

  describe("Fail-Closed Error Handling", () => {
    it("should fail closed on PARSE_STATEMENT execution error", async () => {
      mockExecuteQuery.mockRejectedValue(new Error("Connection failed"));

      const result = await run("SELECT * FROM users");

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(String(JsonRpcErrorCode.ValidationError));
      expect(result.error?.message).toContain(
        "Unable to execute PARSE_STATEMENT",
      );
      expect(result.error?.details).toMatchObject({
        validationMethod: "parse_statement",
        originalError: "Connection failed",
      });
      expect(mockExecuteQueryWithPagination).not.toHaveBeenCalled();
    });

    it("should fail closed on unexpected errors", async () => {
      mockExecuteQuery.mockRejectedValue("Unexpected string error");

      const result = await run("SELECT * FROM users");

      expect(result.success).toBe(false);
      expect(mockExecuteQueryWithPagination).not.toHaveBeenCalled();
    });

    it("should report McpError from PARSE_STATEMENT as-is", async () => {
      const originalError = new McpError(
        JsonRpcErrorCode.DatabaseError,
        "Custom database error",
        { custom: "details" },
      );

      mockExecuteQuery.mockRejectedValue(originalError);

      const result = await run("SELECT * FROM users");

      // McpErrors are reported as-is (not wrapped)
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(String(JsonRpcErrorCode.DatabaseError));
      expect(result.error?.message).toBe("Custom database error");
      expect(result.error?.details).toEqual({ custom: "details" });
      expect(mockExecuteQueryWithPagination).not.toHaveBeenCalled();
    });

    it("should report a failed query execution as an error", async () => {
      mockParsedType("QUERY");
      mockExecuteQueryWithPagination.mockRejectedValue(
        new Error("SQL0204 - USERS not found"),
      );

      const result = await run("SELECT * FROM users");

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(String(JsonRpcErrorCode.DatabaseError));
      expect(result.error?.message).toContain("SQL0204");
    });
  });

  describe("Edge Cases", () => {
    it("should handle queries with missing SQL_STATEMENT_TYPE", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{}]), // No SQL_STATEMENT_TYPE field
      );

      // Should treat empty string as non-QUERY in readonly mode
      const result = await run("SELECT * FROM users");

      expect(result.success).toBe(false);
      expect(mockExecuteQueryWithPagination).not.toHaveBeenCalled();
    });

    it("should handle lowercase statement types", async () => {
      mockParsedType("query"); // lowercase

      // Should convert to uppercase and match
      const result = await run("SELECT * FROM users");

      expect(result.success).toBe(true);
    });

    it("should handle null data in result", async () => {
      mockExecuteQuery.mockResolvedValue(createMockQueryResult(null));

      const result = await run("SELECT * FROM users");

      expect(result.success).toBe(false);
      expect(mockExecuteQueryWithPagination).not.toHaveBeenCalled();
    });

    it("should handle undefined data in result", async () => {
      mockExecuteQuery.mockResolvedValue(createMockQueryResult(undefined));

      const result = await run("SELECT * FROM users");

      expect(result.success).toBe(false);
      expect(mockExecuteQueryWithPagination).not.toHaveBeenCalled();
    });

    it.each(["SELECT * FROM users;", "SELECT * FROM users;;; "])(
      "should strip trailing semicolons before validating and executing: %j",
      async (sql) => {
        mockParsedType("QUERY");

        const result = await run(sql);

        expect(result.success).toBe(true);
        // Both PARSE_STATEMENT and the execution see the sanitized statement
        expect(mockExecuteQuery).toHaveBeenCalledWith(
          expect.stringContaining("PARSE_STATEMENT"),
          ["SELECT * FROM users"],
          context,
        );
        expect(mockExecuteQueryWithPagination).toHaveBeenCalledWith(
          "SELECT * FROM users",
          [],
          context,
        );
      },
    );
  });

  describe("PARSE_STATEMENT Query Structure", () => {
    it("should use correct PARSE_STATEMENT parameters", async () => {
      mockParsedType("QUERY");

      await run("SELECT * FROM test");

      // Verify the PARSE_STATEMENT query structure
      const callArgs = mockExecuteQuery.mock.calls[0]!;
      expect(callArgs[0]).toContain("PARSE_STATEMENT");
      expect(callArgs[0]).toContain("SQL_STATEMENT =>");
      expect(callArgs[0]).toContain("NAMING => '*SQL'");
      expect(callArgs[0]).toContain("DECIMAL_POINT => '*PERIOD'");
      expect(callArgs[0]).toContain("SQL_STRING_DELIMITER => '*APOSTSQL'");
      expect(callArgs[0]).toContain("DISTINCT SQL_STATEMENT_TYPE");
      expect(callArgs[1]).toEqual(["SELECT * FROM test"]);
    });
  });
});
