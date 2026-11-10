/**
 * @fileoverview Tests for YAML tool configuration parsing.
 * Runs the fixtures and inline YAML through the product parser
 * (ConfigParser.parseYamlFile) and the product parameter schema.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { ConfigParser } from "../../../src/ibmi-mcp-server/utils/config/configParser.js";
import { ToolsetManager } from "../../../src/ibmi-mcp-server/utils/config/toolsetManager.js";
import { SqlToolParameterSchema } from "../../../src/ibmi-mcp-server/schemas/config.js";
import { logger } from "../../../src/utils/internal/logger.js";

let tmpRoot: string;
let inlineCount = 0;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ibmi-mcp-yaml-parser-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Parse a fixture file with the product parser
function parseFixture(relativePath: string) {
  return ConfigParser.parseYamlFile(
    resolve(process.cwd(), "tests/fixtures", relativePath),
  );
}

// Parse inline YAML with the product parser
function parseYaml(yamlContent: string) {
  const filePath = join(tmpRoot, `inline-${inlineCount++}.yaml`);
  writeFileSync(filePath, yamlContent);
  return ConfigParser.parseYamlFile(filePath);
}

describe("YAML Parser Unit Tests", () => {
  describe("Optional Sections", () => {
    it("should parse sources-only file successfully", async () => {
      const result = await parseFixture("sources-only.yaml");

      expect(result.success).toBe(true);
      expect(result.config?.sources).toBeDefined();
      expect(result.config?.tools).toBeUndefined();
      expect(result.config?.toolsets).toBeUndefined();
    });

    it("should parse tools-only file successfully", async () => {
      const result = await parseFixture("tools-only.yaml");

      expect(result.success).toBe(true);
      expect(result.config?.sources).toBeUndefined();
      expect(result.config?.tools).toBeDefined();
      expect(result.config?.toolsets).toBeUndefined();
    });

    it("should parse toolsets-only file successfully", async () => {
      const result = await parseFixture("toolsets-only.yaml");

      expect(result.success).toBe(true);
      expect(result.config?.sources).toBeUndefined();
      expect(result.config?.tools).toBeUndefined();
      expect(result.config?.toolsets).toBeDefined();
    });

    it("should parse complete file successfully", async () => {
      const result = await parseFixture("complete.yaml");

      expect(result.success).toBe(true);
      expect(result.config?.sources).toBeDefined();
      expect(result.config?.tools).toBeDefined();
      expect(result.config?.toolsets).toBeDefined();
    });

    it("should reject empty file", async () => {
      const result = await parseFixture("invalid/empty.yaml");

      expect(result.success).toBe(false);
      expect(
        result.errors?.some((error) => error.includes("expected object")),
      ).toBe(true);
    });
  });

  describe("Schema Validation", () => {
    it("should validate required fields in sources", async () => {
      const result = await parseFixture("invalid/missing-required-fields.yaml");

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some((error) => error.includes("user"))).toBe(true);
      expect(result.errors?.some((error) => error.includes("password"))).toBe(
        true,
      );
    });

    it("should validate parameter types", async () => {
      const invalidParamConfig = `
tools:
  invalid-param-tool:
    source: test-source
    description: "Tool with invalid parameter"
    statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"
    parameters:
      - name: invalid-param
        type: invalid-type
        description: "Invalid parameter type"
`;

      const result = await parseYaml(invalidParamConfig);
      expect(result.success).toBe(false);
      expect(
        result.errors?.some((error) => error.includes("parameters.0.type")),
      ).toBe(true);
    });

    it("should validate required tool fields", async () => {
      const invalidToolConfig = `
tools:
  incomplete-tool:
    source: test-source
    # Missing description and statement
`;

      const result = await parseYaml(invalidToolConfig);
      expect(result.success).toBe(false);
      expect(
        result.errors?.some((error) => error.includes("description")),
      ).toBe(true);
    });

    it("should require a statement on every tool", async () => {
      const toolWithoutStatement = `
tools:
  no-statement-tool:
    source: test-source
    description: "Tool without a statement"
`;

      const result = await parseYaml(toolWithoutStatement);
      expect(result.success).toBe(false);
      expect(result.errors).toEqual([
        "Tool 'no-statement-tool' must have a non-empty statement field",
      ]);
    });
  });

  describe("Cross-Reference Validation", () => {
    it("should reject a tool that references an unknown source", async () => {
      const result = await parseFixture(
        "cross-reference-errors/tool-missing-source.yaml",
      );

      expect(result.success).toBe(false);
      expect(
        result.errors?.some((error) =>
          error.includes(
            "Tool 'invalid-tool' references unknown source 'non-existent-source'",
          ),
        ),
      ).toBe(true);
    });

    it("should reject a toolset that references an unknown tool", async () => {
      // Toolset references are checked after files are merged, by the
      // ToolsetManager, so the per-file parse succeeds.
      const result = await parseFixture(
        "cross-reference-errors/toolset-missing-tool.yaml",
      );
      expect(result.success).toBe(true);

      await expect(
        ToolsetManager.getInstance().initialize(result.config!),
      ).rejects.toThrow(
        /Toolset 'invalid-toolset' references unknown tool 'non-existent-tool'/,
      );
    });
  });

  describe("Environment Variable Interpolation", () => {
    afterEach(() => {
      delete process.env.TEST_HOST;
      delete process.env.TEST_USER;
      delete process.env.TEST_PASS;
    });

    const yamlContent = `
sources:
  test-source:
    host: \${TEST_HOST}
    user: \${TEST_USER}
    password: \${TEST_PASS}
    port: 8076
`;

    it("should handle environment variables in YAML", async () => {
      process.env.TEST_HOST = "test-host.example.com";
      process.env.TEST_USER = "test-user";
      process.env.TEST_PASS = "test-password";

      const result = await parseYaml(yamlContent);
      expect(result.success).toBe(true);
      expect(result.config?.sources?.["test-source"]?.host).toBe(
        "test-host.example.com",
      );
      expect(result.config?.sources?.["test-source"]?.user).toBe("test-user");
      expect(result.config?.sources?.["test-source"]?.password).toBe(
        "test-password",
      );
    });

    it("should not write substituted values to the log", async () => {
      process.env.TEST_HOST = "test-host.example.com";
      process.env.TEST_USER = "test-user";
      process.env.TEST_PASS = "S3cretPw";

      const logged: unknown[][] = [];
      for (const level of ["debug", "info", "warning", "error"] as const) {
        vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
          logged.push(args);
        });
      }

      const result = await parseYaml(yamlContent);
      expect(result.success).toBe(true);

      const output = JSON.stringify(logged);
      expect(output).toContain("TEST_PASS");
      expect(output).not.toContain("S3cr");
    });
  });

  describe("Parameter Validation", () => {
    it("should validate valid parameter types", () => {
      const validTypes = ["string", "boolean", "integer", "float", "array"];

      validTypes.forEach((type) => {
        const param = {
          name: "test-param",
          type: type as unknown,
          description: "Test parameter",
        };

        const result = SqlToolParameterSchema.safeParse(param);
        expect(result.success).toBe(true);
      });
    });

    it("should reject invalid parameter types", () => {
      ["invalid-type", "number"].forEach((type) => {
        const invalidParam = {
          name: "test-param",
          type,
          description: "Test parameter",
        };

        const result = SqlToolParameterSchema.safeParse(invalidParam);
        expect(result.success).toBe(false);
      });
    });

    it("should require parameter name", () => {
      const paramWithoutName = {
        type: "string",
        description: "Test parameter",
      };

      const result = SqlToolParameterSchema.safeParse(paramWithoutName);
      expect(result.success).toBe(false);
    });

    it("should validate array parameters with itemType", () => {
      const arrayParam = {
        name: "ids",
        type: "array",
        itemType: "integer",
        description: "Array of user IDs",
        minLength: 1,
        maxLength: 100,
      };

      const result = SqlToolParameterSchema.safeParse(arrayParam);
      expect(result.success).toBe(true);
    });

    it("should validate parameters with validation constraints", () => {
      const constrainedParam = {
        name: "age",
        type: "integer",
        description: "User age",
        min: 0,
        max: 120,
        required: true,
      };

      const result = SqlToolParameterSchema.safeParse(constrainedParam);
      expect(result.success).toBe(true);
    });

    it("should validate parameters with enum values", () => {
      const enumParam = {
        name: "status",
        type: "string",
        description: "User status",
        enum: ["active", "inactive", "pending"],
        required: true,
      };

      const result = SqlToolParameterSchema.safeParse(enumParam);
      expect(result.success).toBe(true);
    });

    it("should validate parameters with pattern", () => {
      const patternParam = {
        name: "username",
        type: "string",
        description: "IBM i username",
        pattern: "^[A-Z0-9_]{1,10}$",
        required: true,
      };

      const result = SqlToolParameterSchema.safeParse(patternParam);
      expect(result.success).toBe(true);
    });
  });

  describe("Tool Configuration Validation", () => {
    it("should parse tools with regular parameters", async () => {
      const toolWithParams = `
tools:
  user-query:
    source: test-source
    description: "Query user information"
    statement: "SELECT * FROM users WHERE name = :username AND age > :minAge"
    parameters:
      - name: username
        type: string
        description: "User name to search for"
        required: true
      - name: minAge
        type: integer
        description: "Minimum age filter"
        min: 0
        max: 120
        default: 18
`;

      const result = await parseYaml(toolWithParams);
      expect(result.success).toBe(true);
      expect(result.config?.tools?.["user-query"]?.parameters).toHaveLength(2);
      expect(result.config?.tools?.["user-query"]?.parameters?.[0].name).toBe(
        "username",
      );
      expect(result.config?.tools?.["user-query"]?.parameters?.[0].type).toBe(
        "string",
      );
      expect(result.config?.tools?.["user-query"]?.parameters?.[1].name).toBe(
        "minAge",
      );
      expect(result.config?.tools?.["user-query"]?.parameters?.[1].type).toBe(
        "integer",
      );
    });

    it("should validate tools without any parameters", async () => {
      const toolWithoutParams = `
tools:
  simple-query:
    source: test-source
    description: "Simple static query"
    statement: "SELECT COUNT(*) as total_users FROM users"
`;

      const result = await parseYaml(toolWithoutParams);
      expect(result.success).toBe(true);
      expect(
        result.config?.tools?.["simple-query"]?.parameters,
      ).toBeUndefined();
    });
  });

  describe("Configuration Counts", () => {
    it("should count sources correctly", async () => {
      const result = await parseFixture("sources-only.yaml");

      expect(result.success).toBe(true);
      expect(result.stats?.sourceCount).toBe(3);
    });

    it("should count tools correctly", async () => {
      const result = await parseFixture("tools-only.yaml");

      expect(result.success).toBe(true);
      expect(result.stats?.toolCount).toBe(3);
    });

    it("should count toolsets correctly", async () => {
      const result = await parseFixture("toolsets-only.yaml");

      expect(result.success).toBe(true);
      expect(result.stats?.toolsetCount).toBe(3);
    });
  });
});
