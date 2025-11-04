import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  ExecuteSqlInputSchema,
  executeSqlLogic,
  ExecuteSqlResponseSchema,
} from "../../../../src/ibmi-mcp-server/tools/executeSql/logic.js";
import { McpError } from "../../../../src/types-global/errors.js";
import { IBMiConnectionPool } from "../../../../src/ibmi-mcp-server/services/connectionPool.js";

// Mock the IBMiConnectionPool
vi.mock("../../../../src/ibmi-mcp-server/services/connectionPool.js");

describe("executeSqlLogic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Input Validation", () => {
    it("should validate valid SQL input", () => {
      const validInput = { sql: "SELECT * FROM SYSIBM.SYSDUMMY1" };
      const validation = ExecuteSqlInputSchema.safeParse(validInput);
      expect(validation.success).toBe(true);
    });

    it("should reject empty SQL input", () => {
      const invalidInput = { sql: "" };
      const validation = ExecuteSqlInputSchema.safeParse(invalidInput);
      expect(validation.success).toBe(false);
      expect(validation.error?.issues[0]?.message).toContain("cannot be empty");
    });

    it("should reject SQL input that's too long", () => {
      const invalidInput = { sql: "SELECT * ".repeat(2000) }; // Creates a very long string
      const validation = ExecuteSqlInputSchema.safeParse(invalidInput);
      expect(validation.success).toBe(false);
      expect(validation.error?.issues[0]?.message).toContain("cannot exceed");
    });
  });

  describe("Security Validation", () => {
    it("should reject SQL with restricted keywords at start", async () => {
      const restrictedQueries = [
        "DROP TABLE test",
        "DELETE FROM users",
        "TRUNCATE TABLE logs",
        "ALTER TABLE users ADD COLUMN",
        "CREATE TABLE test",
        "INSERT INTO users VALUES",
        "UPDATE users SET name",
      ];

      for (const sql of restrictedQueries) {
        const input = { sql };
        await expect(executeSqlLogic(input)).rejects.toThrow(McpError);
        await expect(executeSqlLogic(input)).rejects.toThrow(
          "restricted keyword",
        );
      }
    });

    it("should reject SQL with dangerous patterns", async () => {
      const dangerousQueries = [
        "SELECT * FROM users; DROP TABLE users;",
        "SELECT * FROM users UNION SELECT password FROM admin INTO temp",
        "EXEC('DROP TABLE users')",
        "CALL destructive_procedure()",
      ];

      for (const sql of dangerousQueries) {
        const input = { sql };
        await expect(executeSqlLogic(input)).rejects.toThrow(McpError);
        await expect(executeSqlLogic(input)).rejects.toThrow(
          "dangerous patterns",
        );
      }
    });

    it("should allow safe SELECT queries", async () => {
      const safeQuery = "SELECT COUNT(*) FROM SYSIBM.SYSDUMMY1";
      const mockResult = {
        data: [{ "00001": 1 }],
        metadata: {},
        success: true,
        is_done: true,
        has_results: true,
        update_count: 0,
        id: "test-query-1",
        sql_rc: 0,
        sql_state: "00000",
        execution_time: 100,
      };

      vi.mocked(IBMiConnectionPool.executeQuery).mockResolvedValue(mockResult);

      const input = { sql: safeQuery };
      const result = await executeSqlLogic(input);

      expect(result).toBeDefined();
      expect(result.data).toEqual([{ "00001": 1 }]);
      expect(result.rowCount).toBe(1);
    });
  });

  describe("SQL Execution", () => {
    it("should execute valid SQL and return results", async () => {
      const mockResult = {
        data: [
          { ID: 1, NAME: "Test User 1" },
          { ID: 2, NAME: "Test User 2" },
        ],
        metadata: {
          column_count: 2,
          columns: [
            {
              display_size: 10,
              label: "ID",
              name: "ID",
              type: "INTEGER",
              precision: 10,
              scale: 0,
              autoIncrement: false,
              nullable: 0,
              readOnly: false,
              writeable: true,
            },
            {
              display_size: 50,
              label: "NAME",
              name: "NAME",
              type: "VARCHAR",
              precision: 50,
              scale: 0,
              autoIncrement: false,
              nullable: 1,
              readOnly: false,
              writeable: true,
            },
          ],
        },
        success: true,
        is_done: true,
        has_results: true,
        update_count: 0,
        id: "test-query-2",
        sql_rc: 0,
        sql_state: "00000",
        execution_time: 150,
      };

      vi.mocked(IBMiConnectionPool.executeQuery).mockResolvedValue(mockResult);

      const input = { sql: "SELECT ID, NAME FROM TEST_TABLE" };
      const result = await executeSqlLogic(input);

      // Validate response schema
      const validation = ExecuteSqlResponseSchema.safeParse(result);
      expect(validation.success).toBe(true);

      // Validate response content
      expect(result.data).toEqual(mockResult.data);
      expect(result.rowCount).toBe(2);
      expect(result.executionTimeMs).toBeTypeOf("number");
      expect(result.metadata).toEqual(mockResult.metadata);
    });

    it("should handle empty result sets", async () => {
      const mockResult = {
        data: [],
        metadata: {},
        success: true,
        is_done: true,
        has_results: false,
        update_count: 0,
        id: "test-query-3",
        sql_rc: 0,
        sql_state: "00000",
        execution_time: 50,
      };

      vi.mocked(IBMiConnectionPool.executeQuery).mockResolvedValue(mockResult);

      const input = { sql: "SELECT * FROM EMPTY_TABLE WHERE 1=0" };
      const result = await executeSqlLogic(input);

      expect(result.data).toEqual([]);
      expect(result.rowCount).toBe(0);
      expect(result.executionTimeMs).toBeTypeOf("number");
    });

    it("should handle database errors", async () => {
      const mockResult = {
        data: [],
        metadata: {},
        success: false,
        is_done: true,
        has_results: false,
        update_count: 0,
        id: "test-query-4",
        sql_rc: -204, // Table not found
        sql_state: "42704",
        execution_time: 25,
      };

      vi.mocked(IBMiConnectionPool.executeQuery).mockResolvedValue(mockResult);

      const input = { sql: "SELECT * FROM NONEXISTENT_TABLE" };

      await expect(executeSqlLogic(input)).rejects.toThrow(McpError);
      await expect(executeSqlLogic(input)).rejects.toThrow("execution failed");
    });

    it("should handle connection pool errors", async () => {
      const connectionError = new Error("Connection pool unavailable");

      vi.mocked(IBMiConnectionPool.executeQuery).mockRejectedValue(
        connectionError,
      );

      const input = { sql: "SELECT * FROM SYSIBM.SYSDUMMY1" };

      await expect(executeSqlLogic(input)).rejects.toThrow(McpError);
      await expect(executeSqlLogic(input)).rejects.toThrow(
        "Connection pool unavailable",
      );
    });
  });

  describe("Response Validation", () => {
    it("should return response matching the schema", async () => {
      const mockResult = {
        data: [{ TEST_COL: "test_value" }],
        metadata: {
          column_count: 1,
          job: "123",
        },
        success: true,
        is_done: true,
        has_results: true,
        update_count: 0,
        id: "test-query-5",
        sql_rc: 0,
        sql_state: "00000",
        execution_time: 75,
      };

      vi.mocked(IBMiConnectionPool.executeQuery).mockResolvedValue(mockResult);

      const input = {
        sql: "SELECT 'test_value' AS TEST_COL FROM SYSIBM.SYSDUMMY1",
      };
      const result = await executeSqlLogic(input);

      // Validate against Zod schema
      const validation = ExecuteSqlResponseSchema.safeParse(result);
      expect(validation.success).toBe(true);

      // Check all required fields are present
      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("rowCount");
      expect(result).toHaveProperty("executionTimeMs");
      expect(result).toHaveProperty("metadata");

      // Check types
      expect(Array.isArray(result.data)).toBe(true);
      expect(typeof result.rowCount).toBe("number");
      expect(typeof result.executionTimeMs).toBe("number");
      expect(typeof result.metadata).toBe("object");
    });
  });

  describe("Performance Tracking", () => {
    it("should track execution time", async () => {
      const mockResult = {
        data: [{ COUNT: 1 }],
        metadata: {},
        success: true,
        is_done: true,
        has_results: true,
        update_count: 0,
        id: "test-query-6",
        sql_rc: 0,
        sql_state: "00000",
        execution_time: 110,
      };

      // Add artificial delay to test timing
      vi.mocked(IBMiConnectionPool.executeQuery).mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(mockResult), 100)),
      );

      const input = { sql: "SELECT COUNT(*) AS COUNT FROM SYSIBM.SYSDUMMY1" };
      const result = await executeSqlLogic(input);

      expect(result.executionTimeMs).toBeGreaterThan(90); // Should be around 100ms
      expect(result.executionTimeMs).toBeLessThan(200); // With some tolerance
    });
  });
});
