/**
 * Unit tests for tool-factory.ts
 *
 * @feature 001-tool-factory
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  defineTool,
  ToolDefinitionSchema,
} from "../../src/mcp-server/tools/utils/tool-factory.js";

describe("Tool Factory", () => {
  describe("ToolDefinitionSchema validation", () => {
    it("should validate a valid tool definition", () => {
      const validDef = {
        name: "test_tool",
        description: "A test tool",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ result: z.string() }),
        logic: async ({ query }: { query: string }) => ({
          result: `processed: ${query}`,
        }),
      };

      expect(() => ToolDefinitionSchema.parse(validDef)).not.toThrow();
    });

    it("should reject tool name that is not snake_case", () => {
      const invalidDef = {
        name: "TestTool", // camelCase, not snake_case
        description: "A test tool",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ result: z.string() }),
        logic: async () => ({ result: "test" }),
      };

      expect(() => ToolDefinitionSchema.parse(invalidDef)).toThrow(
        /snake_case/,
      );
    });

    it("should reject tool name starting with number", () => {
      const invalidDef = {
        name: "1_test_tool",
        description: "A test tool",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ result: z.string() }),
        logic: async () => ({ result: "test" }),
      };

      expect(() => ToolDefinitionSchema.parse(invalidDef)).toThrow(
        /snake_case/,
      );
    });

    it("should reject empty tool name", () => {
      const invalidDef = {
        name: "",
        description: "A test tool",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ result: z.string() }),
        logic: async () => ({ result: "test" }),
      };

      expect(() => ToolDefinitionSchema.parse(invalidDef)).toThrow(/required/);
    });

    it("should reject empty description", () => {
      const invalidDef = {
        name: "test_tool",
        description: "",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ result: z.string() }),
        logic: async () => ({ result: "test" }),
      };

      expect(() => ToolDefinitionSchema.parse(invalidDef)).toThrow(/required/);
    });

    it("should reject non-Zod-object inputSchema", () => {
      const invalidDef = {
        name: "test_tool",
        description: "A test tool",
        inputSchema: z.string(), // Not a ZodObject
        outputSchema: z.object({ result: z.string() }),
        logic: async () => ({ result: "test" }),
      };

      expect(() => ToolDefinitionSchema.parse(invalidDef)).toThrow(
        /must be a Zod object schema/,
      );
    });

    it("should reject non-Zod-object outputSchema", () => {
      const invalidDef = {
        name: "test_tool",
        description: "A test tool",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.string(), // Not a ZodObject
        logic: async () => ({ result: "test" }),
      };

      expect(() => ToolDefinitionSchema.parse(invalidDef)).toThrow(
        /must be a Zod object schema/,
      );
    });

    it("should accept optional fields (title, responseFormatter, annotations, enabled)", () => {
      const validDefWithOptionals = {
        name: "test_tool",
        description: "A test tool",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ result: z.string() }),
        logic: async ({ query }: { query: string }) => ({
          result: `processed: ${query}`,
        }),
        title: "Test Tool",
        responseFormatter: (result: { result: string }) => ({
          content: [{ type: "text", text: result.result }],
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
        },
        enabled: true,
      };

      expect(() =>
        ToolDefinitionSchema.parse(validDefWithOptionals),
      ).not.toThrow();
    });

    it("should accept enabled as function", () => {
      const validDef = {
        name: "test_tool",
        description: "A test tool",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ result: z.string() }),
        logic: async () => ({ result: "test" }),
        enabled: () => true,
      };

      expect(() => ToolDefinitionSchema.parse(validDef)).not.toThrow();
    });
  });

  describe("defineTool()", () => {
    it("should return the same definition object", () => {
      const definition = {
        name: "test_tool",
        description: "A test tool",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ result: z.string() }),
        logic: async ({ query }: { query: string }) => ({
          result: `processed: ${query}`,
        }),
      };

      const result = defineTool(definition);
      expect(result).toBe(definition);
    });

    it("should validate definition and throw on invalid input", () => {
      const invalidDefinition = {
        name: "InvalidName", // camelCase
        description: "Test",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ result: z.string() }),
        logic: async () => ({ result: "test" }),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => defineTool(invalidDefinition as any)).toThrow(/snake_case/);
    });
  });
});
