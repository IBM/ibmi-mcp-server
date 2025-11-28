import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerExecuteSqlTool,
  setExecuteSqlConfig,
  getExecuteSqlConfig,
  isExecuteSqlEnabled,
  type ExecuteSqlToolConfig,
} from "../../../../src/ibmi-mcp-server/tools/executeSql/registration.js";
import { IBMiConnectionPool } from "../../../../src/ibmi-mcp-server/services/connectionPool.js";

// Mock dependencies
vi.mock("../../../../src/ibmi-mcp-server/services/connectionPool.js");

// Type for MCP tool handler function
type ToolHandlerFunction = (
  params: unknown,
  context: unknown,
) => Promise<{
  structuredContent?: unknown;
  content?: { type: string; text: string }[];
  isError?: boolean;
}>;

describe("Execute SQL Tool Registration", () => {
  let mockServer: McpServer;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock MCP server
    mockServer = {
      registerTool: vi.fn(),
    } as unknown as McpServer;

    // Reset configuration to defaults
    setExecuteSqlConfig({ enabled: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Configuration Management", () => {
    it("should set and get configuration", () => {
      const testConfig: ExecuteSqlToolConfig = {
        enabled: true,
        description: "Test execute SQL tool",
        security: {
          readOnly: true,
          maxQueryLength: 5000,
          forbiddenKeywords: ["DANGEROUS"],
        },
      };

      setExecuteSqlConfig(testConfig);
      const retrieved = getExecuteSqlConfig();

      expect(retrieved.enabled).toBe(true);
      expect(retrieved.description).toBe("Test execute SQL tool");
      expect(retrieved.security?.readOnly).toBe(true);
      expect(retrieved.security?.maxQueryLength).toBe(5000);
      expect(retrieved.security?.forbiddenKeywords).toEqual(["DANGEROUS"]);
    });

    it("should merge partial configuration with defaults", () => {
      const partialConfig = {
        enabled: false,
        security: {
          maxQueryLength: 8000,
        },
      };

      setExecuteSqlConfig(partialConfig);
      const retrieved = getExecuteSqlConfig();

      expect(retrieved.enabled).toBe(false);
      expect(retrieved.security?.readOnly).toBe(true); // Should keep default
      expect(retrieved.security?.maxQueryLength).toBe(8000);
      expect(retrieved.security?.forbiddenKeywords).toEqual([]); // Should keep default
    });

    it("should correctly report enabled status", () => {
      setExecuteSqlConfig({ enabled: true });
      expect(isExecuteSqlEnabled()).toBe(true);

      setExecuteSqlConfig({ enabled: false });
      expect(isExecuteSqlEnabled()).toBe(false);
    });
  });

  describe("Tool Registration", () => {
    it("should register tool when enabled", async () => {
      setExecuteSqlConfig({ enabled: true });

      await registerExecuteSqlTool(mockServer);

      expect(mockServer.registerTool).toHaveBeenCalledOnce();

      const registerCall = vi.mocked(mockServer.registerTool).mock.calls[0];
      expect(registerCall[0]).toBe("execute_sql"); // tool name
      expect(registerCall[1]).toMatchObject({
        title: "Execute SQL",
        description: expect.stringContaining("SQL statements"),
        annotations: expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        }),
        _meta: expect.objectContaining({
          requiresAuth: true,
        }),
      });
      expect(typeof registerCall[2]).toBe("function"); // handler function
    });

    it("should skip registration when disabled", async () => {
      setExecuteSqlConfig({ enabled: false });

      await registerExecuteSqlTool(mockServer);

      expect(mockServer.registerTool).not.toHaveBeenCalled();
    });

    it("should use custom description when provided", async () => {
      const customDescription = "Custom SQL executor for testing";
      setExecuteSqlConfig({
        enabled: true,
        description: customDescription,
      });

      await registerExecuteSqlTool(mockServer);

      const registerCall = vi.mocked(mockServer.registerTool).mock.calls[0];
      expect(registerCall[1].description).toBe(customDescription);
    });
  });

  describe("Tool Handler Integration", () => {
    it("should register handler that processes SQL requests", async () => {
      setExecuteSqlConfig({ enabled: true });
      await registerExecuteSqlTool(mockServer);

      // Get the registered handler
      const registerCall = vi.mocked(mockServer.registerTool).mock.calls[0];
      const handler = registerCall[2] as ToolHandlerFunction;

      // Mock successful SQL execution
      const mockResult = {
        data: [{ RESULT: "success" }],
        success: true,
        is_done: true,
        metadata: {},
        has_results: true,
        update_count: 0,
        id: "mock-query-id",
        job: "mock-job",
        sql_rc: 0,
        sql_state: "00000",
        execution_time: 10,
      };
      vi.mocked(IBMiConnectionPool.executeQuery).mockResolvedValue(mockResult);

      // Test handler execution
      const testParams = {
        sql: "SELECT 'success' AS RESULT FROM SYSIBM.SYSDUMMY1",
      };
      const testContext = { requestId: "test-123" };

      const result = await handler(testParams, testContext);

      expect(result).toHaveProperty("structuredContent");
      expect(result).toHaveProperty("content");
      expect(
        (result as { structuredContent: unknown }).structuredContent,
      ).toMatchObject({
        data: [{ RESULT: "success" }],
        rowCount: 1,
        executionTimeMs: expect.any(Number),
      });
    });

    it("should handle tool execution errors gracefully", async () => {
      setExecuteSqlConfig({ enabled: true });
      await registerExecuteSqlTool(mockServer);

      // Get the registered handler
      const registerCall = vi.mocked(mockServer.registerTool).mock.calls[0];
      const handler = registerCall[2] as ToolHandlerFunction;

      // Mock SQL execution error
      vi.mocked(IBMiConnectionPool.executeQuery).mockRejectedValue(
        new Error("Database connection failed"),
      );

      // Test handler execution with error
      const testParams = { sql: "SELECT * FROM NONEXISTENT_TABLE" };
      const testContext = { requestId: "test-error" };

      const result = await handler(testParams, testContext);

      expect((result as { isError: boolean }).isError).toBe(true);
      expect(
        (result as { content: { text: string }[] }).content[0].text,
      ).toContain("SQL Error:");
      expect(
        (result as { structuredContent: { code: string; message: string } })
          .structuredContent,
      ).toHaveProperty("code");
      expect(
        (result as { structuredContent: { code: string; message: string } })
          .structuredContent,
      ).toHaveProperty("message");
    });

    it("should reject dangerous SQL in handler", async () => {
      setExecuteSqlConfig({ enabled: true });
      await registerExecuteSqlTool(mockServer);

      // Get the registered handler
      const registerCall = vi.mocked(mockServer.registerTool).mock.calls[0];
      const handler = registerCall[2] as ToolHandlerFunction;

      // Test dangerous SQL
      const testParams = { sql: "DROP TABLE users" };
      const testContext = { requestId: "test-dangerous" };

      const result = await handler(testParams, testContext);

      expect((result as { isError: boolean }).isError).toBe(true);
      expect(
        (result as { content: { text: string }[] }).content[0].text,
      ).toContain("restricted keyword");
    });
  });

  describe("Schema Validation", () => {
    it("should register with proper input schema", async () => {
      setExecuteSqlConfig({ enabled: true });
      await registerExecuteSqlTool(mockServer);

      const registerCall = vi.mocked(mockServer.registerTool).mock.calls[0];
      const inputSchema = registerCall[1].inputSchema;

      // Check that sql parameter exists and has correct properties
      expect(inputSchema).toBeDefined();
      expect(inputSchema).toHaveProperty("sql");

      if (inputSchema) {
        expect(inputSchema.sql).toBeDefined();
        expect(inputSchema.sql._def).toHaveProperty("typeName", "ZodString");
        expect(inputSchema.sql.description).toContain("SQL statement");
      }
    });

    it("should register with proper output schema", async () => {
      setExecuteSqlConfig({ enabled: true });
      await registerExecuteSqlTool(mockServer);

      const registerCall = vi.mocked(mockServer.registerTool).mock.calls[0];
      const outputSchema = registerCall[1].outputSchema;

      // Check that expected output fields exist
      expect(outputSchema).toHaveProperty("data");
      expect(outputSchema).toHaveProperty("rowCount");
      expect(outputSchema).toHaveProperty("executionTimeMs");
      expect(outputSchema).toHaveProperty("metadata");
    });
  });

  describe("Error Handling", () => {
    it("should handle registration errors gracefully", async () => {
      setExecuteSqlConfig({ enabled: true });

      // Mock registerTool to throw an error
      vi.mocked(mockServer.registerTool).mockImplementation(() => {
        throw new Error("Registration failed");
      });

      // Should not throw, but handle error internally
      await expect(registerExecuteSqlTool(mockServer)).rejects.toThrow(
        "Registration failed",
      );
    });
  });
});
