import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadYamlFile,
  loadYamlTools,
  buildToolsetMap,
} from "../../src/utils/yaml-loader";

const TEST_DIR = join(tmpdir(), "ibmi-cli-yaml-test-" + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeYaml(name: string, content: string): string {
  const path = join(TEST_DIR, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("loadYamlFile", () => {
  it("should parse a basic YAML tool file", () => {
    const path = writeYaml(
      "test.yaml",
      `
sources:
  ibmi-system:
    host: myhost
    user: myuser
    password: mypass

tools:
  system_status:
    source: ibmi-system
    description: "System status"
    statement: "SELECT * FROM QSYS2.SYSTEM_STATUS_INFO"
    parameters: []

toolsets:
  performance:
    tools:
      - system_status
`,
    );

    const config = loadYamlFile(path);
    expect(config.tools).toHaveProperty("system_status");
    expect(config.tools["system_status"]?.description).toBe("System status");
    expect(config.tools["system_status"]?.statement).toContain("SYSTEM_STATUS_INFO");
    expect(config.toolsets).toHaveProperty("performance");
    expect(config.toolsets["performance"]?.tools).toContain("system_status");
    expect(config.sources).toHaveProperty("ibmi-system");
  });

  it("should interpolate env vars", () => {
    process.env.TEST_YAML_HOST = "test400.example.com";
    const path = writeYaml(
      "env.yaml",
      `
sources:
  ibmi-system:
    host: \${TEST_YAML_HOST}
tools: {}
`,
    );

    const config = loadYamlFile(path);
    expect(config.sources["ibmi-system"]).toHaveProperty("host", "test400.example.com");

    delete process.env.TEST_YAML_HOST;
  });

  it("should default parameters to empty array", () => {
    const path = writeYaml(
      "no-params.yaml",
      `
tools:
  my_tool:
    source: src
    description: "Test"
    statement: "SELECT 1"
`,
    );

    const config = loadYamlFile(path);
    expect(config.tools["my_tool"]?.parameters).toEqual([]);
  });

  it("should parse parameters with types and defaults", () => {
    const path = writeYaml(
      "params.yaml",
      `
tools:
  find_objects:
    source: src
    description: "Find objects"
    statement: "SELECT * FROM TABLE(qsys2.object_statistics(:schema))"
    parameters:
      - name: schema
        type: string
        description: "Schema name"
        required: true
      - name: months
        type: integer
        default: 12
        min: 1
        max: 120
      - name: include_system
        type: boolean
        description: "Include system objects"
`,
    );

    const config = loadYamlFile(path);
    const params = config.tools["find_objects"]?.parameters ?? [];
    expect(params).toHaveLength(3);
    expect(params[0]?.name).toBe("schema");
    expect(params[0]?.type).toBe("string");
    expect(params[0]?.required).toBe(true);
    expect(params[1]?.name).toBe("months");
    expect(params[1]?.type).toBe("integer");
    expect(params[1]?.default).toBe(12);
    expect(params[2]?.type).toBe("boolean");
  });

  it("should throw for non-existent file", () => {
    expect(() => loadYamlFile("/nonexistent/path.yaml")).toThrow(
      "YAML tool file not found",
    );
  });
});

describe("loadYamlTools", () => {
  it("should merge multiple YAML files", () => {
    writeYaml(
      "a.yaml",
      `
tools:
  tool_a:
    source: src
    description: "Tool A"
    statement: "SELECT 1"
toolsets:
  set_a:
    tools: [tool_a]
`,
    );
    writeYaml(
      "b.yaml",
      `
tools:
  tool_b:
    source: src
    description: "Tool B"
    statement: "SELECT 2"
toolsets:
  set_b:
    tools: [tool_b]
`,
    );

    const config = loadYamlTools([
      join(TEST_DIR, "a.yaml"),
      join(TEST_DIR, "b.yaml"),
    ]);
    expect(config.tools).toHaveProperty("tool_a");
    expect(config.tools).toHaveProperty("tool_b");
    expect(config.toolsets).toHaveProperty("set_a");
    expect(config.toolsets).toHaveProperty("set_b");
  });

  it("should scan directories for YAML files", () => {
    mkdirSync(join(TEST_DIR, "subdir"), { recursive: true });
    writeYaml(
      "subdir/one.yaml",
      `
tools:
  dir_tool:
    source: src
    description: "Dir tool"
    statement: "SELECT 1"
`,
    );

    const config = loadYamlTools([join(TEST_DIR, "subdir")]);
    expect(config.tools).toHaveProperty("dir_tool");
  });
});

describe("buildToolsetMap", () => {
  it("should build reverse map from tool to toolsets", () => {
    const toolsets = {
      perf: { tools: ["system_status", "memory_pools"] },
      dev: { tools: ["find_objects", "system_status"] },
    };

    const map = buildToolsetMap(toolsets);
    expect(map.get("system_status")).toEqual(["perf", "dev"]);
    expect(map.get("memory_pools")).toEqual(["perf"]);
    expect(map.get("find_objects")).toEqual(["dev"]);
  });
});
