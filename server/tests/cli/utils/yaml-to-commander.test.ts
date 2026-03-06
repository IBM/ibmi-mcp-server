import { describe, it, expect } from "vitest";
import { Command } from "commander";
import {
  registerToolOptions,
  optsToParams,
  validateRequiredParams,
} from "../../../src/cli/utils/yaml-to-commander";
import type { YamlToolParameter } from "../../../src/cli/utils/yaml-loader";

describe("registerToolOptions", () => {
  it("should register a string option", () => {
    const cmd = new Command("test");
    registerToolOptions(cmd, [
      { name: "schema_name", type: "string", description: "Schema" },
    ]);
    const opt = cmd.options.find((o) => o.long === "--schema-name");
    expect(opt).toBeDefined();
    expect(opt?.flags).toContain("<value>");
  });

  it("should register a boolean flag (no value)", () => {
    const cmd = new Command("test");
    registerToolOptions(cmd, [
      { name: "include_system", type: "boolean", description: "Include system" },
    ]);
    const opt = cmd.options.find((o) => o.long === "--include-system");
    expect(opt).toBeDefined();
    expect(opt?.flags).not.toContain("<value>");
  });

  it("should register an integer option with default", () => {
    const cmd = new Command("test");
    registerToolOptions(cmd, [
      { name: "limit", type: "integer", default: 50 },
    ]);
    const opt = cmd.options.find((o) => o.long === "--limit");
    expect(opt).toBeDefined();
    expect(opt?.defaultValue).toBe(50);
  });

  it("should register a float option", () => {
    const cmd = new Command("test");
    registerToolOptions(cmd, [
      { name: "threshold", type: "float", description: "Threshold value" },
    ]);
    const opt = cmd.options.find((o) => o.long === "--threshold");
    expect(opt).toBeDefined();
  });

  it("should register an array option", () => {
    const cmd = new Command("test");
    registerToolOptions(cmd, [
      { name: "columns", type: "array", description: "Column names" },
    ]);
    const opt = cmd.options.find((o) => o.long === "--columns");
    expect(opt).toBeDefined();
  });

  it("should include enum choices in description", () => {
    const cmd = new Command("test");
    registerToolOptions(cmd, [
      {
        name: "object_type",
        type: "string",
        description: "Object type",
        enum: ["TABLE", "VIEW", "INDEX"],
      },
    ]);
    const opt = cmd.options.find((o) => o.long === "--object-type");
    expect(opt).toBeDefined();
    expect(opt?.description).toContain("TABLE, VIEW, INDEX");
  });
});

describe("optsToParams", () => {
  it("should map camelCase Commander opts to snake_case param names", () => {
    const params: YamlToolParameter[] = [
      { name: "schema_name", type: "string" },
      { name: "months_unused", type: "integer" },
    ];

    const opts = {
      schemaName: "MYLIB",
      monthsUnused: 12,
    };

    const result = optsToParams(opts, params);
    expect(result).toEqual({
      schema_name: "MYLIB",
      months_unused: 12,
    });
  });

  it("should skip undefined values", () => {
    const params: YamlToolParameter[] = [
      { name: "schema_name", type: "string" },
      { name: "filter", type: "string" },
    ];

    const opts = {
      schemaName: "MYLIB",
    };

    const result = optsToParams(opts, params);
    expect(result).toEqual({ schema_name: "MYLIB" });
    expect(result).not.toHaveProperty("filter");
  });

  it("should handle single-word param names (no underscores)", () => {
    const params: YamlToolParameter[] = [
      { name: "limit", type: "integer" },
    ];

    const opts = { limit: 100 };
    const result = optsToParams(opts, params);
    expect(result).toEqual({ limit: 100 });
  });
});

describe("validateRequiredParams", () => {
  it("should return empty array when all required params are present", () => {
    const params: YamlToolParameter[] = [
      { name: "schema", type: "string", required: true },
      { name: "limit", type: "integer", default: 50 },
    ];

    const missing = validateRequiredParams({ schema: "MYLIB" }, params);
    expect(missing).toEqual([]);
  });

  it("should return missing required param names", () => {
    const params: YamlToolParameter[] = [
      { name: "library_name", type: "string", required: true },
      { name: "file_name", type: "string", required: true },
    ];

    const missing = validateRequiredParams({}, params);
    expect(missing).toEqual(["library_name", "file_name"]);
  });

  it("should not report required params with defaults as missing", () => {
    const params: YamlToolParameter[] = [
      { name: "months", type: "integer", required: true, default: 12 },
    ];

    const missing = validateRequiredParams({}, params);
    expect(missing).toEqual([]);
  });
});
