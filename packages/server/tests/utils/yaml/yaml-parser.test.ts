/**
 * @fileoverview Simplified unit tests for YAML parsing functionality
 * Tests core YAML parsing and validation without complex dependencies
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { load as yamlLoad } from "js-yaml";
import { z } from "zod";

// Simple schemas for testing
const YamlToolParameterSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "integer", "float", "array"]),
  description: z.string().optional(),
  default: z.any().optional(),
  required: z.boolean().optional(),
  itemType: z
    .enum(["string", "number", "boolean", "integer", "float"])
    .optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  pattern: z.string().optional(),
});

const YamlSourceSchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1),
  password: z.string().min(1),
  port: z.number().int().positive(),
  "ignore-unauthorized": z.boolean().optional(),
});

const YamlToolSchema = z.object({
  source: z.string().min(1),
  description: z.string().min(1),
  statement: z.string().min(1),
  parameters: z.array(YamlToolParameterSchema).optional(),
  domain: z.string().optional(),
  category: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const YamlToolsetSchema = z.object({
  tools: z.array(z.string().min(1)),
});

const YamlToolsConfigSchema = z
  .object({
    sources: z.record(z.string().min(1), YamlSourceSchema).optional(),
    tools: z.record(z.string().min(1), YamlToolSchema).optional(),
    toolsets: z.record(z.string().min(1), YamlToolsetSchema).optional(),
    metadata: z.record(z.any()).optional(),
  })
  .refine(
    (data) => {
      return data.sources || data.tools || data.toolsets;
    },
    {
      message:
        "YAML file must contain at least one section: sources, tools, or toolsets",
    },
  );

// Helper function to load fixture
function loadFixture(relativePath: string): string {
  const fixturePath = resolve(process.cwd(), "tests/fixtures", relativePath);
  return readFileSync(fixturePath, "utf-8");
}

// Helper function to parse YAML
function parseYaml(yamlContent: string) {
  try {
    const parsed = yamlLoad(yamlContent);
    const result = YamlToolsConfigSchema.safeParse(parsed);

    if (!result.success) {
      return {
        success: false,
        errors: result.error.errors.map(
          (e) => `${e.path.join(".")}: ${e.message}`,
        ),
      };
    }

    return {
      success: true,
      config: result.data,
    };
  } catch (error) {
    return {
      success: false,
      errors: [error instanceof Error ? error.message : "Parse error"],
    };
  }
}

describe("YAML Parser Unit Tests", () => {
  describe("Optional Sections", () => {
    it("should parse sources-only file successfully", () => {
      const yamlContent = loadFixture("sources-only.yaml");
      const result = parseYaml(yamlContent);

      expect(result.success).toBe(true);
      expect(result.config?.sources).toBeDefined();
      expect(result.config?.tools).toBeUndefined();
      expect(result.config?.toolsets).toBeUndefined();
    });

    it("should parse tools-only file successfully", () => {
      const yamlContent = loadFixture("tools-only.yaml");
      const result = parseYaml(yamlContent);

      expect(result.success).toBe(true);
      expect(result.config?.sources).toBeUndefined();
      expect(result.config?.tools).toBeDefined();
      expect(result.config?.toolsets).toBeUndefined();
    });

    it("should parse toolsets-only file successfully", () => {
      const yamlContent = loadFixture("toolsets-only.yaml");
      const result = parseYaml(yamlContent);

      expect(result.success).toBe(true);
      expect(result.config?.sources).toBeUndefined();
      expect(result.config?.tools).toBeUndefined();
      expect(result.config?.toolsets).toBeDefined();
    });

    it("should parse complete file successfully", () => {
      const yamlContent = loadFixture("complete.yaml");
      const result = parseYaml(yamlContent);

      expect(result.success).toBe(true);
      expect(result.config?.sources).toBeDefined();
      expect(result.config?.tools).toBeDefined();
      expect(result.config?.toolsets).toBeDefined();
    });

    it("should reject empty file", () => {
      const yamlContent = loadFixture("invalid/empty.yaml");
      const result = parseYaml(yamlContent);

      expect(result.success).toBe(false);
      expect(
        result.errors?.some(
          (error) =>
            error.includes("YAML file must contain at least one section") ||
            error.includes("Expected object, received null"),
        ),
      ).toBe(true);
    });
  });

  describe("Schema Validation", () => {
    it("should validate required fields in sources", () => {
      const yamlContent = loadFixture("invalid/missing-required-fields.yaml");
      const result = parseYaml(yamlContent);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some((error) => error.includes("user"))).toBe(true);
      expect(result.errors?.some((error) => error.includes("password"))).toBe(
        true,
      );
    });

    it("should validate parameter types", () => {
      const invalidParamConfig = `
tools:
  invalid-param-tool:
    source: test-source
    description: "Tool with invalid parameter"
    statement: "SELECT 1"
    parameters:
      - name: invalid-param
        type: invalid-type
        description: "Invalid parameter type"
`;

      const result = parseYaml(invalidParamConfig);
      expect(result.success).toBe(false);
      expect(
        result.errors?.some((error) => error.includes("invalid-type")),
      ).toBe(true);
    });

    it("should validate required tool fields", () => {
      const invalidToolConfig = `
tools:
  incomplete-tool:
    source: test-source
    # Missing description and statement
`;

      const result = parseYaml(invalidToolConfig);
      expect(result.success).toBe(false);
      expect(
        result.errors?.some((error) => error.includes("description")),
      ).toBe(true);
      expect(result.errors?.some((error) => error.includes("statement"))).toBe(
        true,
      );
    });
  });

  describe("Environment Variable Interpolation", () => {
    it("should handle environment variables in YAML", () => {
      // Set test environment variables
      process.env.TEST_HOST = "test-host.example.com";
      process.env.TEST_USER = "test-user";
      process.env.TEST_PASS = "test-password";

      const yamlContent = `
sources:
  test-source:
    host: \${TEST_HOST}
    user: \${TEST_USER}
    password: \${TEST_PASS}
    port: 8076
`;

      // Simple environment variable interpolation
      const interpolatedContent = yamlContent.replace(
        /\$\{([^}]+)\}/g,
        (match, varName) => {
          return process.env[varName] || match;
        },
      );

      const result = parseYaml(interpolatedContent);
      expect(result.success).toBe(true);
      expect(result.config?.sources?.["test-source"]?.host).toBe(
        "test-host.example.com",
      );
      expect(result.config?.sources?.["test-source"]?.user).toBe("test-user");
      expect(result.config?.sources?.["test-source"]?.password).toBe(
        "test-password",
      );

      // Clean up
      delete process.env.TEST_HOST;
      delete process.env.TEST_USER;
      delete process.env.TEST_PASS;
    });
  });

  describe("Parameter Validation", () => {
    it("should validate valid parameter types", () => {
      const validTypes = [
        "string",
        "number",
        "boolean",
        "integer",
        "float",
        "array",
      ];

      validTypes.forEach((type) => {
        const param = {
          name: "test-param",
          type: type as unknown,
          description: "Test parameter",
        };

        const result = YamlToolParameterSchema.safeParse(param);
        expect(result.success).toBe(true);
      });
    });

    it("should reject invalid parameter types", () => {
      const invalidParam = {
        name: "test-param",
        type: "invalid-type",
        description: "Test parameter",
      };

      const result = YamlToolParameterSchema.safeParse(invalidParam);
      expect(result.success).toBe(false);
    });

    it("should require parameter name", () => {
      const paramWithoutName = {
        type: "string",
        description: "Test parameter",
      };

      const result = YamlToolParameterSchema.safeParse(paramWithoutName);
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

      const result = YamlToolParameterSchema.safeParse(arrayParam);
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

      const result = YamlToolParameterSchema.safeParse(constrainedParam);
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

      const result = YamlToolParameterSchema.safeParse(enumParam);
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

      const result = YamlToolParameterSchema.safeParse(patternParam);
      expect(result.success).toBe(true);
    });
  });

  describe("Tool Configuration Validation", () => {
    it("should parse tools with regular parameters", () => {
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

      const result = parseYaml(toolWithParams);
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

    it("should validate tools without any parameters", () => {
      const toolWithoutParams = `
tools:
  simple-query:
    source: test-source
    description: "Simple static query"
    statement: "SELECT COUNT(*) as total_users FROM users"
`;

      const result = parseYaml(toolWithoutParams);
      expect(result.success).toBe(true);
      expect(
        result.config?.tools?.["simple-query"]?.parameters,
      ).toBeUndefined();
    });
  });

  describe("Configuration Counts", () => {
    it("should count sources correctly", () => {
      const yamlContent = loadFixture("sources-only.yaml");
      const result = parseYaml(yamlContent);

      expect(result.success).toBe(true);
      const sourceCount = Object.keys(result.config?.sources || {}).length;
      expect(sourceCount).toBe(3);
    });

    it("should count tools correctly", () => {
      const yamlContent = loadFixture("tools-only.yaml");
      const result = parseYaml(yamlContent);

      expect(result.success).toBe(true);
      const toolCount = Object.keys(result.config?.tools || {}).length;
      expect(toolCount).toBe(3);
    });

    it("should count toolsets correctly", () => {
      const yamlContent = loadFixture("toolsets-only.yaml");
      const result = parseYaml(yamlContent);

      expect(result.success).toBe(true);
      const toolsetCount = Object.keys(result.config?.toolsets || {}).length;
      expect(toolsetCount).toBe(3);
    });
  });
});
