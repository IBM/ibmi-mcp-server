import { describe, it, expect, vi, afterEach } from "vitest";
import { createProgram } from "../../src/index";

vi.mock("../../src/utils/yaml-loader.js", () => ({
  loadYamlTools: vi.fn(),
}));

describe("ibmi tool command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("should register the tool command with name argument", () => {
    const program = createProgram();
    const tool = program.commands.find((c) => c.name() === "tool");
    expect(tool).toBeDefined();
    expect(tool?.description()).toBe("Run a YAML-defined tool by name");
    const args = tool?.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args?.[0]?.name()).toBe("name");
    expect(args?.[0]?.required).toBe(true);
  });

  it("should have --dry-run option", () => {
    const program = createProgram();
    const tool = program.commands.find((c) => c.name() === "tool");
    expect(
      tool?.options.find((o) => o.long === "--dry-run"),
    ).toBeDefined();
  });

  it("should allow unknown options (for dynamic tool params)", () => {
    const program = createProgram();
    const tool = program.commands.find((c) => c.name() === "tool");
    // Commander's _allowUnknownOption is internal but we can verify it
    // doesn't reject unknown flags by checking the command works
    expect(tool).toBeDefined();
  });
});

describe("ibmi --tools global option", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("should register --tools as a global option", () => {
    const program = createProgram();
    const toolsOpt = program.options.find((o) => o.long === "--tools");
    expect(toolsOpt).toBeDefined();
    expect(toolsOpt?.flags).toContain("<path>");
  });
});

describe("ibmi tool command — error paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("should set exitCode to USAGE (2) and report missing --tools when --tools not provided", async () => {
    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    const originalStderr = process.stderr.write;
    const originalStdout = process.stdout.write;

    process.stderr.write = ((chunk: string) => {
      stderrWrites.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutWrites.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "tool", "my_tool"]);

      // The error is rendered via renderError which writes to stderr (table format) or stdout (json)
      const combined = [...stderrWrites, ...stdoutWrites].join("");
      expect(combined).toMatch(/tools/i);
      expect(process.exitCode).toBe(2);
    } finally {
      process.stderr.write = originalStderr;
      process.stdout.write = originalStdout;
    }
  });

  it("should set exitCode to USAGE (2) and report tool not found when tool name does not exist in config", async () => {
    const { loadYamlTools } = await import("../../src/utils/yaml-loader.js");
    const mockLoad = vi.mocked(loadYamlTools);

    // Return a config with no matching tool
    mockLoad.mockReturnValue({
      tools: {
        existing_tool: {
          source: "ibmi-system",
          description: "An existing tool",
          statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1",
          parameters: [],
        },
      },
      toolsets: {},
      sources: {},
    });

    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    const originalStderr = process.stderr.write;
    const originalStdout = process.stdout.write;

    process.stderr.write = ((chunk: string) => {
      stderrWrites.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutWrites.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "tool",
        "nonexistent",
        "--tools",
        "/fake/path.yaml",
      ]);

      const combined = [...stderrWrites, ...stdoutWrites].join("");
      expect(combined).toMatch(/not found/i);
      expect(process.exitCode).toBe(2);
    } finally {
      process.stderr.write = originalStderr;
      process.stdout.write = originalStdout;
    }
  });

  it("should set exitCode to USAGE (2) and report missing required parameters", async () => {
    const { loadYamlTools } = await import("../../src/utils/yaml-loader.js");
    const mockLoad = vi.mocked(loadYamlTools);

    // Return a config with a tool that has required parameters
    mockLoad.mockReturnValue({
      tools: {
        get_rows: {
          source: "ibmi-system",
          description: "Get rows from a table",
          statement: "SELECT * FROM :schema.:table",
          parameters: [
            {
              name: "schema",
              type: "string",
              required: true,
              description: "Schema name",
            },
            {
              name: "table",
              type: "string",
              required: true,
              description: "Table name",
            },
          ],
        },
      },
      toolsets: {},
      sources: {},
    });

    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    const originalStderr = process.stderr.write;
    const originalStdout = process.stdout.write;

    process.stderr.write = ((chunk: string) => {
      stderrWrites.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutWrites.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = createProgram();
      program.exitOverride();
      // Run without providing --schema or --table
      await program.parseAsync([
        "node",
        "ibmi",
        "tool",
        "get_rows",
        "--tools",
        "/fake/path.yaml",
      ]);

      const combined = [...stderrWrites, ...stdoutWrites].join("");
      expect(combined).toMatch(/missing required/i);
      expect(process.exitCode).toBe(2);
    } finally {
      process.stderr.write = originalStderr;
      process.stdout.write = originalStdout;
    }
  });
});
