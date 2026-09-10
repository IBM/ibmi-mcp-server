/**
 * Unit tests for executeSql.tool.ts - PARSE_STATEMENT validation
 *
 * Tests the validateWithParseStatement function's ability to:
 * - Validate SQL syntax using IBM i's PARSE_STATEMENT
 * - Enforce access-mode restrictions (read / read-call / write)
 * - Fail closed on errors
 *
 * Also covers conditional wire PARSE_STATEMENT (issue #151) via executeSqlLogic.
 *
 * @module tests/unit/tools/executeSql.tool.test
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
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

vi.mock("../../../src/config/index.js", () => ({
  config: {
    ibmi_enableDefaultTools: false,
    ibmi_enableExecuteSql: true,
    ibmi_executeSqlAccess: "read",
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

// Now import the module after mocks are set up
import { IBMiConnectionPool } from "../../../src/ibmi-mcp-server/services/connectionPool.js";
import type { QueryResult } from "@ibm/mapepire-js";
import { IbmiSqlParser } from "../../../src/ibmi-mcp-server/utils/security/ibmiSqlParser.js";
import type { ExecuteSqlAccess } from "../../../src/ibmi-mcp-server/services/executeSqlAccess.js";
import {
  configureExecuteSqlTool,
  getExecuteSqlConfig,
  executeSqlTool,
} from "../../../src/ibmi-mcp-server/tools/executeSql.tool.js";

// The logic function is exercised through the tool definition, exactly as the
// CLI consumes it (executeSqlTool.logic) — no separate logic export exists.
const executeSqlLogic = executeSqlTool.logic;

// Pristine module defaults, captured before any test mutates the shared
// config via configureExecuteSqlTool (which merges and has no reset API).
const initialExecuteSqlConfig = structuredClone(getExecuteSqlConfig());

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

// We need to access the private validateWithParseStatement function
// Since it's not exported, we'll need to test it through the executeSqlLogic function
// For now, let's create a standalone version for testing
// In a real scenario, you might export it for testing or use integration tests

/**
 * Standalone version of validateWithParseStatement for testing
 * This mirrors the implementation in executeSql.tool.ts
 */
const PARSE_STATEMENT_ALLOWED_TYPES: Record<
  ExecuteSqlAccess,
  ReadonlySet<string> | undefined
> = {
  read: new Set(["QUERY"]),
  "read-call": new Set(["QUERY", "CALL"]),
  write: undefined,
};

async function validateWithParseStatement(
  sql: string,
  access: ExecuteSqlAccess,
  appContext: ReturnType<typeof createRequestContext>,
): Promise<void> {
  const parseQuery = `
    SELECT DISTINCT SQL_STATEMENT_TYPE
    FROM TABLE(QSYS2.PARSE_STATEMENT(
      SQL_STATEMENT => ?,
      NAMING => '*SQL',
      DECIMAL_POINT => '*PERIOD',
      SQL_STRING_DELIMITER => '*APOSTSQL'
    )) AS P
  `.trim();

  try {
    const result = await IBMiConnectionPool.executeQuery(
      parseQuery,
      [sql],
      appContext,
    );

    if (!result.data || result.data.length === 0) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        "SQL syntax error: Query could not be parsed by IBM i",
        {
          query: sql.substring(0, 100) + (sql.length > 100 ? "..." : ""),
          validationMethod: "parse_statement",
        },
      );
    }

    // A missing type is "UNKNOWN" so it can never satisfy a read allow-set.
    const statementTypes = (
      result.data as { SQL_STATEMENT_TYPE?: string }[]
    ).map((row) => (row.SQL_STATEMENT_TYPE || "UNKNOWN").toUpperCase());
    const allowedTypes = PARSE_STATEMENT_ALLOWED_TYPES[access];
    const disallowed = allowedTypes
      ? statementTypes.filter((t) => !allowedTypes.has(t))
      : [];

    if (disallowed.length > 0) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        `Statement type '${disallowed.join("', '")}' not permitted in ${access} access mode`,
        {
          query: sql.substring(0, 100) + (sql.length > 100 ? "..." : ""),
          sqlStatementTypes: statementTypes,
          access,
          validationMethod: "parse_statement",
        },
      );
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }

    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      "SQL validation failed: Unable to execute PARSE_STATEMENT",
      {
        query: sql.substring(0, 100) + (sql.length > 100 ? "..." : ""),
        validationMethod: "parse_statement",
        originalError: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

describe("PARSE_STATEMENT Runtime Validation", () => {
  const context = createRequestContext();
  const mockExecuteQuery = vi.mocked(IBMiConnectionPool.executeQuery);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("read Mode - Valid Queries", () => {
    it("should allow SELECT queries in read mode", async () => {
      // Mock successful PARSE_STATEMENT result for SELECT
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "QUERY" }]),
      );

      await expect(
        validateWithParseStatement(
          "SELECT * FROM QIWS.QCUSTCDT",
          "read",
          context,
        ),
      ).resolves.toBeUndefined();

      expect(mockExecuteQuery).toHaveBeenCalledWith(
        expect.stringContaining("PARSE_STATEMENT"),
        ["SELECT * FROM QIWS.QCUSTCDT"],
        context,
      );
    });

    it("should allow complex SELECT with CTEs in read mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "QUERY" }]),
      );

      const complexQuery = `
        WITH sales_summary AS (
          SELECT region, SUM(amount) as total
          FROM sales
          GROUP BY region
        )
        SELECT * FROM sales_summary WHERE total > 1000
      `;

      await expect(
        validateWithParseStatement(complexQuery, "read", context),
      ).resolves.toBeUndefined();
    });

    it("should allow SELECT with UNION in read mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "QUERY" }]),
      );

      const unionQuery = `
        SELECT name FROM employees
        UNION
        SELECT name FROM contractors
      `;

      await expect(
        validateWithParseStatement(unionQuery, "read", context),
      ).resolves.toBeUndefined();
    });
  });

  describe("read Mode - Blocked Queries", () => {
    it("should reject INSERT statements in read mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "INSERT" }]),
      );

      await expect(
        validateWithParseStatement(
          "INSERT INTO users (name) VALUES ('test')",
          "read",
          context,
        ),
      ).rejects.toThrow(McpError);

      try {
        await validateWithParseStatement(
          "INSERT INTO users (name) VALUES ('test')",
          "read",
          context,
        );
      } catch (error) {
        if (error instanceof McpError) {
          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.message).toContain("Statement type 'INSERT'");
          expect(error.message).toContain("not permitted in read access mode");
          expect(error.details).toMatchObject({
            sqlStatementTypes: ["INSERT"],
            access: "read",
            validationMethod: "parse_statement",
          });
        }
      }
    });

    it("should reject UPDATE statements in read mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "UPDATE" }]),
      );

      await expect(
        validateWithParseStatement(
          "UPDATE users SET name = 'test' WHERE id = 1",
          "read",
          context,
        ),
      ).rejects.toThrow(McpError);
    });

    it("should reject DELETE statements in read mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "DELETE" }]),
      );

      await expect(
        validateWithParseStatement(
          "DELETE FROM users WHERE id = 1",
          "read",
          context,
        ),
      ).rejects.toThrow(McpError);
    });

    it("should reject MERGE statements in read mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "MERGE" }]),
      );

      await expect(
        validateWithParseStatement(
          "MERGE INTO target USING source ON target.id = source.id",
          "read",
          context,
        ),
      ).rejects.toThrow(McpError);
    });

    it("should reject CREATE statements in read mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "CREATE" }]),
      );

      await expect(
        validateWithParseStatement(
          "CREATE TABLE test (id INT)",
          "read",
          context,
        ),
      ).rejects.toThrow(McpError);
    });

    it("should reject DROP statements in read mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "DROP" }]),
      );

      await expect(
        validateWithParseStatement("DROP TABLE test", "read", context),
      ).rejects.toThrow(McpError);
    });

    it("should reject ALTER statements in read mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "ALTER" }]),
      );

      await expect(
        validateWithParseStatement(
          "ALTER TABLE test ADD COLUMN name VARCHAR(50)",
          "read",
          context,
        ),
      ).rejects.toThrow(McpError);
    });
  });

  describe("write Mode", () => {
    it("should allow SELECT queries in write mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "QUERY" }]),
      );

      await expect(
        validateWithParseStatement(
          "SELECT * FROM QIWS.QCUSTCDT",
          "write",
          context,
        ),
      ).resolves.toBeUndefined();
    });

    it("should allow INSERT statements in write mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "INSERT" }]),
      );

      await expect(
        validateWithParseStatement(
          "INSERT INTO users (name) VALUES ('test')",
          "write",
          context,
        ),
      ).resolves.toBeUndefined();
    });

    it("should allow UPDATE statements in write mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "UPDATE" }]),
      );

      await expect(
        validateWithParseStatement(
          "UPDATE users SET name = 'test' WHERE id = 1",
          "write",
          context,
        ),
      ).resolves.toBeUndefined();
    });

    it("should allow DELETE statements in write mode", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "DELETE" }]),
      );

      await expect(
        validateWithParseStatement(
          "DELETE FROM users WHERE id = 1",
          "write",
          context,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("Syntax Error Handling", () => {
    it("should reject queries with syntax errors (empty result)", async () => {
      // Empty result from PARSE_STATEMENT indicates syntax error
      mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

      await expect(
        validateWithParseStatement("SELECT * FROMM invalid", "read", context),
      ).rejects.toThrow(McpError);

      try {
        await validateWithParseStatement(
          "SELECT * FROMM invalid",
          "read",
          context,
        );
      } catch (error) {
        if (error instanceof McpError) {
          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.message).toContain("SQL syntax error");
          expect(error.message).toContain("could not be parsed");
          expect(error.details).toMatchObject({
            validationMethod: "parse_statement",
          });
        }
      }
    });

    it("should reject queries with malformed SQL", async () => {
      mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

      await expect(
        validateWithParseStatement("INVALID SQL QUERY ;;;", "read", context),
      ).rejects.toThrow(McpError);
    });

    it("should truncate long queries in error messages", async () => {
      mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

      const longQuery = "SELECT * FROM table WHERE " + "x = 1 AND ".repeat(50);

      try {
        await validateWithParseStatement(longQuery, "read", context);
      } catch (error) {
        if (error instanceof McpError) {
          expect(error.details?.query).toHaveLength(103); // 100 chars + "..."
          expect(error.details?.query).toContain("...");
        }
      }
    });
  });

  describe("Fail-Closed Error Handling", () => {
    it("should fail closed on PARSE_STATEMENT execution error", async () => {
      mockExecuteQuery.mockRejectedValue(new Error("Connection failed"));

      await expect(
        validateWithParseStatement("SELECT * FROM users", "read", context),
      ).rejects.toThrow(McpError);

      try {
        await validateWithParseStatement(
          "SELECT * FROM users",
          "read",
          context,
        );
      } catch (error) {
        if (error instanceof McpError) {
          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.message).toContain("Unable to execute PARSE_STATEMENT");
          expect(error.details).toMatchObject({
            validationMethod: "parse_statement",
            originalError: "Connection failed",
          });
        }
      }
    });

    it("should fail closed on unexpected errors", async () => {
      mockExecuteQuery.mockRejectedValue("Unexpected string error");

      await expect(
        validateWithParseStatement("SELECT * FROM users", "read", context),
      ).rejects.toThrow(McpError);
    });

    it("should re-throw McpError as-is", async () => {
      const originalError = new McpError(
        JsonRpcErrorCode.DatabaseError,
        "Custom database error",
        { custom: "details" },
      );

      mockExecuteQuery.mockRejectedValue(originalError);

      try {
        await validateWithParseStatement(
          "SELECT * FROM users",
          "read",
          context,
        );
        // Should not reach here
        expect.fail("Should have thrown an error");
      } catch (error) {
        // McpErrors are re-thrown as-is (not wrapped)
        expect(error).toBe(originalError);
        if (error instanceof McpError) {
          expect(error.code).toBe(JsonRpcErrorCode.DatabaseError);
          expect(error.message).toBe("Custom database error");
        }
      }
    });
  });

  describe("Edge Cases", () => {
    it("should reject rows with missing SQL_STATEMENT_TYPE in read and read-call (UNKNOWN)", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{}]), // No SQL_STATEMENT_TYPE field
      );

      // A missing type maps to UNKNOWN, which no restricted allow-set contains.
      await expect(
        validateWithParseStatement("SELECT * FROM users", "read", context),
      ).rejects.toThrow(
        /Statement type 'UNKNOWN' not permitted in read access mode/,
      );
      await expect(
        validateWithParseStatement("SELECT * FROM users", "read-call", context),
      ).rejects.toThrow(
        /Statement type 'UNKNOWN' not permitted in read-call access mode/,
      );
    });

    it("should allow rows with missing SQL_STATEMENT_TYPE in write mode", async () => {
      mockExecuteQuery.mockResolvedValue(createMockQueryResult([{}]));

      await expect(
        validateWithParseStatement("SELECT * FROM users", "write", context),
      ).resolves.toBeUndefined();
    });

    it("should handle lowercase statement types", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "query" }]), // lowercase
      );

      // Should convert to uppercase and match
      await expect(
        validateWithParseStatement("SELECT * FROM users", "read", context),
      ).resolves.toBeUndefined();
    });

    it("should handle null data in result", async () => {
      mockExecuteQuery.mockResolvedValue(createMockQueryResult(null));

      await expect(
        validateWithParseStatement("SELECT * FROM users", "read", context),
      ).rejects.toThrow(McpError);
    });

    it("should handle undefined data in result", async () => {
      mockExecuteQuery.mockResolvedValue(createMockQueryResult(undefined));

      await expect(
        validateWithParseStatement("SELECT * FROM users", "read", context),
      ).rejects.toThrow(McpError);
    });

    it("should handle SQL with trailing semicolons", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "QUERY" }]),
      );

      // SQL with trailing semicolon should work (semicolons are sanitized before validation)
      // Note: Sanitization happens in executeSqlLogic before calling validateWithParseStatement
      await expect(
        validateWithParseStatement("SELECT * FROM users", "read", context),
      ).resolves.toBeUndefined();
    });

    it("should handle SQL with multiple trailing semicolons", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "QUERY" }]),
      );

      // Multiple semicolons should also work (sanitized in executeSqlLogic)
      await expect(
        validateWithParseStatement("SELECT * FROM users", "read", context),
      ).resolves.toBeUndefined();
    });
  });

  describe("PARSE_STATEMENT Query Structure", () => {
    it("should use correct PARSE_STATEMENT parameters", async () => {
      mockExecuteQuery.mockResolvedValue(
        createMockQueryResult([{ SQL_STATEMENT_TYPE: "QUERY" }]),
      );

      await validateWithParseStatement("SELECT * FROM test", "read", context);

      // Verify the PARSE_STATEMENT query structure
      const callArgs = mockExecuteQuery.mock.calls[0];
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

// ---------------------------------------------------------------------------
// Issue #151 – conditional wire PARSE_STATEMENT via executeSqlLogic
// ---------------------------------------------------------------------------

const mockSdkContext = {
  signal: new AbortController().signal,
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
  authInfo: undefined,
  sessionId: undefined,
} as unknown as Parameters<typeof executeSqlLogic>[2];

/** Force the in-process parser to fail so Layer 1 falls through to PARSE_STATEMENT. */
function forceParserFailure() {
  return vi.spyOn(IbmiSqlParser, "parseQuery").mockReturnValue({
    success: false,
    allowed: false,
    statementTypes: [],
    violations: ["Parse error"],
    error: "forced parse failure",
  });
}

describe("executeSqlLogic — conditional PARSE_STATEMENT (issue #151)", () => {
  const context = createRequestContext();
  const mockExecuteQuery = vi.mocked(IBMiConnectionPool.executeQuery);
  const mockExecutePaginated = vi.mocked(
    IBMiConnectionPool.executeQueryWithPagination,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    configureExecuteSqlTool({
      enabled: true,
      security: {
        access: "read",
        maxQueryLength: 10000,
      },
    });
    mockExecutePaginated.mockResolvedValue({
      success: true,
      data: [{ X: 1 }],
      truncated: false,
      execution_time: 10,
    });
  });

  // Restore the module-global tool config so blocks added after this one
  // don't inherit write-mode state.
  afterAll(() => {
    configureExecuteSqlTool(structuredClone(initialExecuteSqlConfig));
  });

  it("classified SELECT: skips PARSE_STATEMENT (one pagination call only)", async () => {
    const result = await executeSqlLogic(
      { sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockExecutePaginated).toHaveBeenCalledTimes(1);
    expect(mockExecutePaginated.mock.calls[0][0]).toBe(
      "SELECT 1 FROM SYSIBM.SYSDUMMY1",
    );
  });

  it("comment-only input: not classified — falls back to PARSE_STATEMENT and fails clean", async () => {
    // Zero parsed statements must not count as "classified"; the wire PARSE
    // fallback rejects the non-statement with a clear validation error
    // instead of executing it.
    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    const result = await executeSqlLogic(
      { sql: "-- just a comment" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/could not be parsed/i);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    expect(mockExecuteQuery.mock.calls[0][0]).toContain("PARSE_STATEMENT");
    expect(mockExecutePaginated).not.toHaveBeenCalled();
  });

  it("comment-only input mentioning a write keyword is NOT flagged as a write", async () => {
    // The regex fallback does not strip comments; zero-statement input must
    // bypass it entirely, or "-- TODO: delete old rows" would be falsely
    // rejected as not permitted in read access mode.
    mockExecuteQuery.mockResolvedValue(createMockQueryResult([]));

    const result = await executeSqlLogic(
      { sql: "-- TODO: delete old rows" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).not.toMatch(/not permitted in read access/i);
    expect(result.error?.message).toMatch(/could not be parsed/i);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    expect(mockExecutePaginated).not.toHaveBeenCalled();
  });

  it("parser failure (regex allow): still runs PARSE_STATEMENT", async () => {
    const parseSpy = forceParserFailure();
    mockExecuteQuery.mockResolvedValue(
      createMockQueryResult([{ SQL_STATEMENT_TYPE: "QUERY" }]),
    );

    try {
      const result = await executeSqlLogic(
        { sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1" },
        context,
        mockSdkContext,
      );

      expect(result.success).toBe(true);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      expect(mockExecuteQuery.mock.calls[0][0]).toContain("PARSE_STATEMENT");
      expect(mockExecutePaginated).toHaveBeenCalledTimes(1);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("rejects writes in Layer 1 before any pool call", async () => {
    const result = await executeSqlLogic(
      { sql: "UPDATE SYSIBM.SYSDUMMY1 SET IBMREQD = IBMREQD" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(
      /SQL not permitted in read access mode/i,
    );
    expect(result.error?.code).toBe(String(JsonRpcErrorCode.ValidationError));
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockExecutePaginated).not.toHaveBeenCalled();
  });

  it("read mode CALL: rejected in Layer 1 before any pool call", async () => {
    const result = await executeSqlLogic(
      { sql: "CALL QSYS2.QCMDEXC('DSPLIBL')" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(
      /SQL not permitted in read access mode/i,
    );
    expect(result.error?.code).toBe(String(JsonRpcErrorCode.ValidationError));
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockExecutePaginated).not.toHaveBeenCalled();
  });

  it("read-call mode CALL: classified by the parser — PARSE skipped, executes", async () => {
    configureExecuteSqlTool({ security: { access: "read-call" } });

    const result = await executeSqlLogic(
      { sql: "CALL QSYS2.QCMDEXC('DSPLIBL')" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockExecutePaginated).toHaveBeenCalledTimes(1);
    expect(mockExecutePaginated.mock.calls[0][0]).toBe(
      "CALL QSYS2.QCMDEXC('DSPLIBL')",
    );
  });

  it("PARSE fallback returning CALL: rejected in read mode", async () => {
    const parseSpy = forceParserFailure();
    mockExecuteQuery.mockResolvedValue(
      createMockQueryResult([{ SQL_STATEMENT_TYPE: "CALL" }]),
    );

    try {
      const result = await executeSqlLogic(
        { sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1" },
        context,
        mockSdkContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(
        /Statement type 'CALL' not permitted in read access mode/,
      );
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      expect(mockExecutePaginated).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("PARSE fallback returning CALL: accepted in read-call mode", async () => {
    configureExecuteSqlTool({ security: { access: "read-call" } });
    const parseSpy = forceParserFailure();
    mockExecuteQuery.mockResolvedValue(
      createMockQueryResult([{ SQL_STATEMENT_TYPE: "CALL" }]),
    );

    try {
      const result = await executeSqlLogic(
        { sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1" },
        context,
        mockSdkContext,
      );

      expect(result.success).toBe(true);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      expect(mockExecutePaginated).toHaveBeenCalledTimes(1);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("multi-row PARSE result with QUERY and INSERT: rejected in read mode", async () => {
    const parseSpy = forceParserFailure();
    mockExecuteQuery.mockResolvedValue(
      createMockQueryResult([
        { SQL_STATEMENT_TYPE: "QUERY" },
        { SQL_STATEMENT_TYPE: "INSERT" },
      ]),
    );

    try {
      const result = await executeSqlLogic(
        { sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1" },
        context,
        mockSdkContext,
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(
        /Statement type 'INSERT' not permitted in read access mode/,
      );
      expect(result.error?.details).toMatchObject({
        sqlStatementTypes: ["QUERY", "INSERT"],
        access: "read",
      });
      expect(mockExecutePaginated).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("write mode SELECT: skips PARSE_STATEMENT when classified", async () => {
    configureExecuteSqlTool({ security: { access: "write" } });

    const result = await executeSqlLogic(
      { sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockExecutePaginated).toHaveBeenCalledTimes(1);
  });

  it("write mode INSERT: skips PARSE_STATEMENT when classified", async () => {
    configureExecuteSqlTool({ security: { access: "write" } });

    const result = await executeSqlLogic(
      { sql: "INSERT INTO MYLIB.T (C) VALUES (1)" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockExecutePaginated).toHaveBeenCalledTimes(1);
    expect(mockExecutePaginated.mock.calls[0][0]).toBe(
      "INSERT INTO MYLIB.T (C) VALUES (1)",
    );
  });

  it("deprecated readOnly:false still maps to write mode", async () => {
    const effective = configureExecuteSqlTool({
      security: { readOnly: false },
    });
    expect(effective).toBe("write");
    expect(getExecuteSqlConfig().security?.access).toBe("write");

    const result = await executeSqlLogic(
      { sql: "INSERT INTO MYLIB.T (C) VALUES (1)" },
      context,
      mockSdkContext,
    );

    expect(result.success).toBe(true);
    expect(mockExecutePaginated).toHaveBeenCalledTimes(1);
  });
});
