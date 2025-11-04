/**
 * @fileoverview Integration tests for YamlSqlExecutor parameter binding
 * Tests parameter binding and SQL execution with YAML parameter definitions
 */

import { describe, it, expect, beforeEach, vi, Mock } from "vitest";

// Mock the SourceManager BEFORE importing anything that depends on it
vi.mock("../../../src/ibmi-mcp-server/services/sourceManager.js");

// Mock the scheduling module to prevent scheduler instantiation
vi.mock("../../../src/utils/scheduling/index.js", () => ({
  schedulerService: vi.fn(),
}));

import { SQLToolFactory } from "../../../src/ibmi-mcp-server/utils/config/toolFactory.js";
import { SourceManager } from "../../../src/ibmi-mcp-server/services/sourceManager.js";
import { SqlToolParameter } from "../../../src/ibmi-mcp-server/schemas/index.js";
import { requestContextService } from "../../../src/utils/internal/requestContext.js";

describe("SQLToolFactory - Parameter Binding", () => {
  let mockSourceManager: {
    executeQuery: Mock;
  };
  let testContext: ReturnType<
    typeof requestContextService.createRequestContext
  >;

  beforeEach(() => {
    // Create mock source manager
    mockSourceManager = {
      executeQuery: vi.fn(),
    };

    // Initialize SQLToolFactory with mock
    SQLToolFactory.initialize(mockSourceManager as unknown as SourceManager);

    // Create test context
    testContext = requestContextService.createRequestContext({
      operation: "TestSQLToolFactory",
    });

    // Reset mocks
    vi.clearAllMocks();

    // Setup default successful response
    mockSourceManager.executeQuery.mockResolvedValue({
      success: true,
      data: [
        { id: 1, name: "test_user", age: 30 },
        { id: 2, name: "another_user", age: 25 },
      ],
      metadata: { affectedRows: 0 },
    });
  });

  describe("Parameter Binding (Secure Parameters)", () => {
    it("should execute SQL with named parameters using parameter binding", async () => {
      const toolName = "get_user_by_name";
      const sourceName = "test_source";
      const sql =
        "SELECT * FROM users WHERE name = :username AND age > :minAge";
      const parameters = {
        username: "john_doe",
        minAge: 18,
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "username", type: "string", description: "User name" },
        { name: "minAge", type: "integer", description: "Minimum age", min: 0 },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        toolName,
        sourceName,
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(result.parameterMetadata?.mode).toBe("parameters");
      expect(result.parameterMetadata?.parameterCount).toBe(2);

      // Verify the source manager was called with processed SQL and parameters
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        sourceName,
        "SELECT * FROM users WHERE name = ? AND age > ?",
        ["john_doe", 18],
        expect.any(Object), // context
      );
    });

    it("should execute SQL with positional parameters", async () => {
      const sql = "SELECT * FROM users WHERE name = ? AND age > ?";
      const parameters = {
        "0": "john_doe",
        "1": 18,
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "0", type: "string" },
        { name: "1", type: "integer" },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "test_tool",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users WHERE name = ? AND age > ?",
        ["john_doe", 18],
        expect.any(Object),
      );
    });

    it("should handle array parameters for IN clauses", async () => {
      const sql =
        "SELECT * FROM users WHERE id IN (:userIds) AND status = :status";
      const parameters = {
        userIds: [1, 2, 3],
        status: "active",
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "userIds", type: "array", itemType: "integer" },
        { name: "status", type: "string", enum: ["active", "inactive"] },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "get_users_by_ids",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users WHERE id IN (?, ?, ?) AND status = ?",
        [1, 2, 3, "active"],
        expect.any(Object),
      );
    });

    it("should validate parameters and reject invalid values", async () => {
      const sql = "SELECT * FROM users WHERE age = :age";
      const parameters = {
        age: "not-a-number", // Invalid integer
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "age", type: "integer", min: 0, max: 120 },
      ];

      await expect(
        SQLToolFactory.executeStatementWithParameters(
          "test_tool",
          "test_source",
          sql,
          parameters,
          parameterDefinitions,
          testContext,
        ),
      ).rejects.toThrow("Parameter validation failed");

      // Should not call executeQuery due to validation failure
      expect(mockSourceManager.executeQuery).not.toHaveBeenCalled();
    });

    it("should handle missing required parameters", async () => {
      const sql =
        "SELECT * FROM users WHERE name = :username AND age > :minAge";
      const parameters = {
        username: "john_doe",
        // minAge is missing
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "username", type: "string", required: true },
        { name: "minAge", type: "integer", required: true },
      ];

      await expect(
        SQLToolFactory.executeStatementWithParameters(
          "test_tool",
          "test_source",
          sql,
          parameters,
          parameterDefinitions,
          testContext,
        ),
      ).rejects.toThrow("Parameter validation failed");
    });

    it("should use default values for optional parameters", async () => {
      const sql =
        "SELECT * FROM users WHERE name = :username AND active = :active";
      const parameters = {
        username: "john_doe",
        // active is not provided, should use default
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "username", type: "string", required: true },
        { name: "active", type: "boolean", default: true, required: false },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "test_tool",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users WHERE name = ? AND active = ?",
        ["john_doe", 1], // Boolean default true converted to 1
        expect.any(Object),
      );
    });
  });

  describe("No Parameters", () => {
    it("should use SQL as-is when no parameter definitions provided", async () => {
      const sql = "SELECT COUNT(*) as total_users FROM users";
      const parameters = {};

      const result = await SQLToolFactory.executeStatementWithParameters(
        "test_tool",
        "test_source",
        sql,
        parameters,
        [], // No parameter definitions
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(result.parameterMetadata?.mode).toBe("none");

      // Should call with original SQL and no binding parameters
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT COUNT(*) as total_users FROM users",
        [], // No binding parameters
        expect.any(Object),
      );
    });
  });

  describe("Real-world Use Cases", () => {
    it("should handle getUserProfile.rule with named parameters", async () => {
      const sql =
        "select * from qsys2.user_info_basic where authorization_name = :username";
      const parameters = {
        username: "TESTUSER",
      };
      const parameterDefinitions: SqlToolParameter[] = [
        {
          name: "username",
          type: "string",
          description: "The user profile name to lookup",
          required: true,
          pattern: "^[A-Z0-9_]{1,10}$", // IBM i user name pattern
        },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "getUserProfile",
        "ibmi-system",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "ibmi-system",
        "select * from qsys2.user_info_basic where authorization_name = ?",
        ["TESTUSER"],
        expect.any(Object),
      );
    });

    it("should handle executeCl.rule with named parameters", async () => {
      const sql = "call qsys2.qcmdexc(:clCommand)";
      const parameters = {
        clCommand: "DSPLIB QSYS",
      };
      const parameterDefinitions: SqlToolParameter[] = [
        {
          name: "clCommand",
          type: "string",
          description: "The CL command to execute",
          required: true,
          maxLength: 1000,
        },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "executeCl",
        "ibmi-system",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "ibmi-system",
        "call qsys2.qcmdexc(?)",
        ["DSPLIB QSYS"],
        expect.any(Object),
      );
    });

    it("should handle complex audit journal query with multiple parameters", async () => {
      const sql = `
        SELECT entry_timestamp, user_name, object_name, object_type 
        FROM qsys2.audit_journal_af 
        WHERE entry_timestamp >= :startDate 
          AND entry_timestamp <= :endDate
          AND user_name = :userName
          AND object_type IN (:objectTypes)
        ORDER BY entry_timestamp DESC
        LIMIT :maxResults
      `;
      const parameters = {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        userName: "TESTUSER",
        objectTypes: ["*FILE", "*PGM", "*SRVPGM"],
        maxResults: 100,
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "startDate", type: "string", required: true },
        { name: "endDate", type: "string", required: true },
        { name: "userName", type: "string", required: true },
        {
          name: "objectTypes",
          type: "array",
          itemType: "string",
          maxLength: 10,
        },
        {
          name: "maxResults",
          type: "integer",
          min: 1,
          max: 1000,
          default: 100,
        },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "auditJournalQuery",
        "ibmi-system",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();

      // Verify all parameters are properly bound
      const [, processedSql, bindingParams] =
        mockSourceManager.executeQuery.mock.calls[0];
      expect(processedSql).toContain("WHERE entry_timestamp >= ?");
      expect(processedSql).toContain("AND entry_timestamp <= ?");
      expect(processedSql).toContain("AND user_name = ?");
      expect(processedSql).toContain("AND object_type IN (?, ?, ?)");
      expect(processedSql).toContain("LIMIT ?");

      expect(bindingParams).toEqual([
        "2024-01-01",
        "2024-12-31",
        "TESTUSER",
        "*FILE",
        "*PGM",
        "*SRVPGM",
        100,
      ]);
    });
  });

  describe("Error Handling", () => {
    it("should handle database execution errors", async () => {
      mockSourceManager.executeQuery.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const sql = "SELECT * FROM users WHERE name = :username";
      const parameters = { username: "test" };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "username", type: "string" },
      ];

      await expect(
        SQLToolFactory.executeStatementWithParameters(
          "test_tool",
          "test_source",
          sql,
          parameters,
          parameterDefinitions,
          testContext,
        ),
      ).rejects.toThrow("Database connection failed");
    });

    it("should handle SQL syntax errors", async () => {
      mockSourceManager.executeQuery.mockRejectedValue(
        new Error("SQL syntax error"),
      );

      const sql = "SELECT * FROM users WHERE invalid syntax";
      const parameters = {};

      await expect(
        SQLToolFactory.executeStatementWithParameters(
          "test_tool",
          "test_source",
          sql,
          parameters,
          [], // No parameter definitions
          testContext,
        ),
      ).rejects.toThrow("SQL syntax error");
    });

    it("should handle uninitialized executor", async () => {
      // Create a new instance without initializing
      SQLToolFactory.initialize(undefined as unknown as SourceManager);

      await expect(
        SQLToolFactory.executeStatementWithParameters(
          "test_tool",
          "test_source",
          "SELECT 1",
          {},
          [], // No parameter definitions
          testContext,
        ),
      ).rejects.toThrow("YAML SQL executor not initialized");
    });
  });

  describe("Hybrid Parameter Mode", () => {
    it("should handle mix of named and positional parameters", async () => {
      // This would be a malformed query in real usage, but tests the hybrid mode detection
      const sql =
        "SELECT * FROM users WHERE name = :username AND age > ? AND active = :active";
      const parameters = {
        username: "john_doe",
        active: true,
        // Missing positional parameter should be handled gracefully
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "username", type: "string", required: true },
        { name: "active", type: "boolean", required: true },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "hybrid_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();

      // Verify named parameters were converted to positional
      const [, processedSql, bindingParams] =
        mockSourceManager.executeQuery.mock.calls[0];
      expect(processedSql).toContain(
        "WHERE name = ? AND age > ? AND active = ?",
      );
      expect(bindingParams).toEqual(["john_doe", 1]); // Only the named params that were available
    });

    it("should handle hybrid mode with template detection", async () => {
      const sql = "SELECT * FROM {{tableName}} WHERE name = :username";
      const parameters = {
        tableName: "users",
        username: "john_doe",
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "tableName", type: "string", required: true },
        { name: "username", type: "string", required: true },
      ];

      // Should detect template mode and reject
      await expect(
        SQLToolFactory.executeStatementWithParameters(
          "template_test",
          "test_source",
          sql,
          parameters,
          parameterDefinitions,
          testContext,
        ),
      ).rejects.toThrow("Template mode");
    });
  });

  describe("Edge Cases and Validation", () => {
    it("should handle empty parameter definitions gracefully", async () => {
      const sql = "SELECT * FROM users";
      const parameters = { someParam: "ignored" };

      const result = await SQLToolFactory.executeStatementWithParameters(
        "no_params_test",
        "test_source",
        sql,
        parameters,
        [], // Empty parameter definitions
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(result.parameterMetadata?.mode).toBe("none");
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users",
        [],
        expect.any(Object),
      );
    });

    it("should handle special characters in parameter names", async () => {
      const sql =
        "SELECT * FROM users WHERE name = :user_name AND age = :min_age_value";
      const parameters = {
        user_name: "test_user",
        min_age_value: 21,
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "user_name", type: "string", pattern: "^[a-zA-Z_]+$" },
        { name: "min_age_value", type: "integer", min: 18, max: 100 },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "special_chars_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users WHERE name = ? AND age = ?",
        ["test_user", 21],
        expect.any(Object),
      );
    });

    it("should handle SQL with quotes containing parameter-like strings", async () => {
      const sql =
        "SELECT * FROM users WHERE name = :username AND description LIKE '%:not_a_param%'";
      const parameters = {
        username: "john_doe",
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "username", type: "string", required: true },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "quoted_strings_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();

      // Should only replace actual parameters, not quoted strings
      const [, processedSql, bindingParams] =
        mockSourceManager.executeQuery.mock.calls[0];
      expect(processedSql).toBe(
        "SELECT * FROM users WHERE name = ? AND description LIKE '%:not_a_param%'",
      );
      expect(bindingParams).toEqual(["john_doe"]);
    });

    it("should handle duplicate parameter names", async () => {
      const sql =
        "SELECT * FROM users WHERE name = :username OR email = :username";
      const parameters = {
        username: "john_doe",
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "username", type: "string", required: true },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "duplicate_params_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();

      // Should replace both instances with the same value
      const [, processedSql, bindingParams] =
        mockSourceManager.executeQuery.mock.calls[0];
      expect(processedSql).toBe(
        "SELECT * FROM users WHERE name = ? OR email = ?",
      );
      expect(bindingParams).toEqual(["john_doe", "john_doe"]);
    });

    it("should handle type conversion edge cases", async () => {
      const sql =
        "SELECT * FROM users WHERE active = :active AND count = :count AND ratio = :ratio";
      const parameters = {
        active: "true", // String to boolean
        count: "42", // String to integer
        ratio: "3.14", // String to float
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "active", type: "boolean" },
        { name: "count", type: "integer", min: 1 },
        { name: "ratio", type: "float", min: 0.0 },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "type_conversion_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users WHERE active = ? AND count = ? AND ratio = ?",
        [1, 42, 3.14], // Converted values
        expect.any(Object),
      );
    });

    it("should handle complex nested array with enum validation", async () => {
      const sql =
        "SELECT * FROM users WHERE status IN (:statuses) AND roles IN (:roles)";
      const parameters = {
        statuses: ["active", "pending"],
        roles: ["admin", "user", "guest"],
      };
      const parameterDefinitions: SqlToolParameter[] = [
        {
          name: "statuses",
          type: "array",
          itemType: "string",
          enum: ["active", "inactive", "pending", "suspended"],
        },
        {
          name: "roles",
          type: "array",
          itemType: "string",
          enum: ["admin", "user", "guest", "moderator"],
          maxLength: 5,
        },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "complex_array_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users WHERE status IN (?, ?) AND roles IN (?, ?, ?)",
        ["active", "pending", "admin", "user", "guest"],
        expect.any(Object),
      );
    });

    it("should handle invalid enum values in arrays", async () => {
      const sql = "SELECT * FROM users WHERE status IN (:statuses)";
      const parameters = {
        statuses: ["active", "invalid_status"],
      };
      const parameterDefinitions: SqlToolParameter[] = [
        {
          name: "statuses",
          type: "array",
          itemType: "string",
          enum: ["active", "inactive", "pending"],
        },
      ];

      await expect(
        SQLToolFactory.executeStatementWithParameters(
          "invalid_enum_test",
          "test_source",
          sql,
          parameters,
          parameterDefinitions,
          testContext,
        ),
      ).rejects.toThrow("not one of allowed values");
    });

    it("should handle parameter with complex default values", async () => {
      const sql =
        "SELECT * FROM users WHERE created_after = :startDate AND status = :status AND limit_count = :limit";
      const parameters = {
        // Only provide one parameter, others should use defaults
        startDate: "2024-01-01",
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "startDate", type: "string", required: true },
        {
          name: "status",
          type: "string",
          default: "active",
          enum: ["active", "inactive"],
        },
        { name: "limit", type: "integer", default: 100, min: 1, max: 1000 },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "complex_defaults_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users WHERE created_after = ? AND status = ? AND limit_count = ?",
        ["2024-01-01", "active", 100], // Default values applied
        expect.any(Object),
      );
    });

    it("should handle malformed SQL syntax validation", async () => {
      const sql =
        "SELECT * FROM users WHERE name = 'unmatched quote AND id = :id";
      const parameters = { id: 123 };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "id", type: "integer" },
      ];

      await expect(
        SQLToolFactory.executeStatementWithParameters(
          "malformed_sql_test",
          "test_source",
          sql,
          parameters,
          parameterDefinitions,
          testContext,
        ),
      ).rejects.toThrow("Unmatched single quotes");
    });

    it("should handle malformed parameter syntax", async () => {
      const sql = "SELECT * FROM users WHERE id = :123invalid"; // Parameter name can't start with number
      const parameters = { "123invalid": 123 };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "123invalid", type: "integer" },
      ];

      await expect(
        SQLToolFactory.executeStatementWithParameters(
          "invalid_param_syntax_test",
          "test_source",
          sql,
          parameters,
          parameterDefinitions,
          testContext,
        ),
      ).rejects.toThrow("Invalid named parameter syntax");
    });

    it("should handle parameters with null and undefined edge cases", async () => {
      const sql = "SELECT * FROM users WHERE name = :name AND age = :age";
      const parameters = {
        name: null,
        age: undefined,
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "name", type: "string", required: false, default: "unknown" },
        { name: "age", type: "integer", required: false, default: 0 },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "null_undefined_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users WHERE name = ? AND age = ?",
        ["unknown", 0], // Default values used for null/undefined
        expect.any(Object),
      );
    });

    it("should handle extremely long parameter values", async () => {
      const longString = "x".repeat(5000);
      const sql = "SELECT * FROM users WHERE description = :description";
      const parameters = {
        description: longString,
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "description", type: "string", maxLength: 10000 },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "long_string_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users WHERE description = ?",
        [longString],
        expect.any(Object),
      );
    });

    it("should reject parameter values exceeding length limits", async () => {
      const longString = "x".repeat(1001);
      const sql = "SELECT * FROM users WHERE description = :description";
      const parameters = {
        description: longString,
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "description", type: "string", maxLength: 1000 },
      ];

      await expect(
        SQLToolFactory.executeStatementWithParameters(
          "length_limit_test",
          "test_source",
          sql,
          parameters,
          parameterDefinitions,
          testContext,
        ),
      ).rejects.toThrow("must be at most 1000 characters long");
    });

    it("should handle complex boolean conversions", async () => {
      const sql =
        "SELECT * FROM settings WHERE flag1 = :flag1 AND flag2 = :flag2 AND flag3 = :flag3 AND flag4 = :flag4";
      const parameters = {
        flag1: "yes",
        flag2: "off",
        flag3: 1,
        flag4: 0,
      };
      const parameterDefinitions: SqlToolParameter[] = [
        { name: "flag1", type: "boolean" },
        { name: "flag2", type: "boolean" },
        { name: "flag3", type: "boolean" },
        { name: "flag4", type: "boolean" },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "boolean_conversion_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM settings WHERE flag1 = ? AND flag2 = ? AND flag3 = ? AND flag4 = ?",
        [1, 0, 1, 0], // All converted to DB2-compatible integers
        expect.any(Object),
      );
    });

    it("should handle regex pattern validation edge cases", async () => {
      const sql = "SELECT * FROM users WHERE email = :email AND phone = :phone";
      const parameters = {
        email: "test@example.com",
        phone: "+1-555-0123",
      };
      const parameterDefinitions: SqlToolParameter[] = [
        {
          name: "email",
          type: "string",
          pattern: "^[\\w.-]+@[\\w.-]+\\.[a-zA-Z]{2,}$",
        },
        {
          name: "phone",
          type: "string",
          pattern: "^\\+?[1-9]\\d{1,14}$|^\\+?[1-9]-\\d{3}-\\d{4}$",
        },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "regex_validation_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users WHERE email = ? AND phone = ?",
        ["test@example.com", "+1-555-0123"],
        expect.any(Object),
      );
    });

    it("should handle invalid regex patterns gracefully", async () => {
      const sql = "SELECT * FROM users WHERE name = :name";
      const parameters = {
        name: "test_user",
      };
      const parameterDefinitions: SqlToolParameter[] = [
        {
          name: "name",
          type: "string",
          pattern: "[invalid regex(", // Malformed regex
        },
      ];

      const result = await SQLToolFactory.executeStatementWithParameters(
        "invalid_regex_test",
        "test_source",
        sql,
        parameters,
        parameterDefinitions,
        testContext,
      );

      // Should succeed but log a warning about invalid pattern
      expect(result.data).toBeDefined();
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        "SELECT * FROM users WHERE name = ?",
        ["test_user"],
        expect.any(Object),
      );
    });
  });

  describe("Performance and Optimization", () => {
    it("should include execution metrics in results", async () => {
      // Simulate slower execution
      mockSourceManager.executeQuery.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          success: true,
          data: [{ id: 1, name: "test" }],
          metadata: { affectedRows: 1 },
        };
      });

      const result = await SQLToolFactory.executeStatementWithParameters(
        "test_tool",
        "test_source",
        "SELECT * FROM users WHERE id = :id",
        { id: 1 },
        [{ name: "id", type: "integer" }],
        testContext,
      );

      expect(result.data).toBeDefined();
      expect(result.executionTime).toBeGreaterThan(0);
      expect(result.rowCount).toBe(1);
      expect(result.parameterMetadata?.mode).toBe("parameters");
      expect(result.parameterMetadata?.parameterCount).toBe(1);
    });

    it("should handle large parameter arrays efficiently", async () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => i + 1);

      const result = await SQLToolFactory.executeStatementWithParameters(
        "test_tool",
        "test_source",
        "SELECT * FROM users WHERE id IN (:ids)",
        { ids: largeArray },
        [{ name: "ids", type: "array", itemType: "integer", maxLength: 1000 }],
        testContext,
      );

      expect(result.data).toBeDefined();
      // Array parameters are expanded to individual placeholders
      const expectedPlaceholders = largeArray.map(() => "?").join(", ");
      expect(mockSourceManager.executeQuery).toHaveBeenCalledWith(
        "test_source",
        `SELECT * FROM users WHERE id IN (${expectedPlaceholders})`,
        largeArray,
        expect.any(Object),
      );
    });
  });
});
