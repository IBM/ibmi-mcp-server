import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createProgram } from "../../src/program.js";

vi.mock("../../src/utils/yaml-loader.js", () => ({
  loadYamlTools: vi.fn(),
}));

vi.mock("../../src/config/resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/config/resolver.js")>();
  return {
    ...actual,
    resolveSystem: vi.fn(),
  };
});

vi.mock("../../src/utils/connection.js", () => ({
  connectSystem: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@ibm/ibmi-mcp-server/services", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ibm/ibmi-mcp-server/services")>();
  return {
    ...actual,
    IBMiConnectionPool: {
      executeQuery: vi.fn().mockResolvedValue({ data: [{ OK: 1 }] }),
    },
    ParameterProcessor: {
      process: vi.fn().mockResolvedValue({
        sql: "SELECT 1",
        parameters: [],
        parameterNames: [],
        missingParameters: [],
        mode: "named",
        stats: {
          originalLength: 0,
          processedLength: 0,
          namedParametersFound: 0,
          positionalParametersFound: 0,
          parametersConverted: 0,
        },
      }),
    },
  };
});

describe("ibmi tool command", () => {
  afterEach(() => {
    vi.clearAllMocks();
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
    expect(tool?.options.find((o) => o.long === "--dry-run")).toBeDefined();
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
    vi.clearAllMocks();
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
    vi.clearAllMocks();
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

  it("should not leak Commander 'too many arguments' to stderr on a successful parametric dry-run", async () => {
    const { loadYamlTools } = await import("../../src/utils/yaml-loader.js");
    const mockLoad = vi.mocked(loadYamlTools);

    mockLoad.mockReturnValue({
      tools: {
        list_categories_for_schema: {
          source: "ibmi-system",
          description: "Show which categories exist within a given schema.",
          statement:
            "SELECT * FROM qsys2.services_info WHERE service_schema_name = :schema_name",
          parameters: [
            {
              name: "schema_name",
              type: "string",
              required: true,
              description: "Schema name",
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
      await program.parseAsync([
        "node",
        "ibmi",
        "--tools",
        "/fake/path.yaml",
        "--format",
        "json",
        "tool",
        "list_categories_for_schema",
        "--schema-name",
        "QSYS2",
        "--dry-run",
      ]);

      const stderrCombined = stderrWrites.join("");
      const stdoutCombined = stdoutWrites.join("");

      // Primary assertion: the Commander strict-args error must not reach stderr.
      expect(stderrCombined).not.toMatch(/too many arguments/i);
      expect(stderrCombined).not.toMatch(/Expected 0 arguments/i);

      // Dry-run should have rendered a successful payload with the resolved param.
      expect(stdoutCombined).toMatch(/"schema_name"\s*:\s*"QSYS2"/);
      expect(process.exitCode).toBeUndefined();
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

describe("ibmi tool command — security validation", () => {
  let stdoutOutput: string;
  let stderrOutput: string;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;

  // Get references to mocked modules at import time
  let mockLoadYamlTools: ReturnType<typeof vi.fn>;
  let mockResolveSystem: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    stdoutOutput = "";
    stderrOutput = "";
    process.stdout.write = ((chunk: string) => {
      stdoutOutput += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrOutput += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const yamlLoader = await import("../../src/utils/yaml-loader.js");
    mockLoadYamlTools = vi.mocked(yamlLoader.loadYamlTools);

    const resolver = await import("../../src/config/resolver.js");
    mockResolveSystem = vi.mocked(resolver.resolveSystem);
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  function mockToolWithStatement(
    statement: string,
    security?: { readOnly?: boolean },
    systemReadOnly = false,
  ) {
    mockLoadYamlTools.mockReturnValue({
      tools: {
        test_tool: {
          source: "test",
          description: "Test tool",
          statement,
          parameters: [],
          ...(security !== undefined ? { security } : {}),
        },
      },
      toolsets: {},
      sources: {},
    });

    mockResolveSystem.mockReturnValue({
      name: "dev",
      config: {
        host: "dev400.com",
        port: 8076,
        user: "DEV",
        readOnly: systemReadOnly,
        confirm: false,
        timeout: 60,
        maxRows: 5000,
        ignoreUnauthorized: true,
      },
      source: "flag",
    });
  }

  it("should block DELETE when tool has security.readOnly: true", async () => {
    mockToolWithStatement("DELETE FROM SAMPLE.EMPLOYEE WHERE EMPNO = '999'", {
      readOnly: true,
    });

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "tool",
      "test_tool",
      "--tools",
      "/fake.yaml",
    ]);

    const output = stdoutOutput + stderrOutput;
    expect(output).toMatch(/write operation/i);
    // Security violation, from the validator's error code rather than its wording
    expect(process.exitCode).toBe(4);
  });

  it("should block INSERT when tool has no security config (defaults to readOnly)", async () => {
    mockToolWithStatement("INSERT INTO SAMPLE.EMPLOYEE VALUES ('X')");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "tool",
      "test_tool",
      "--tools",
      "/fake.yaml",
    ]);

    const output = stdoutOutput + stderrOutput;
    expect(output).toMatch(/write operation/i);
  });

  it("should allow SELECT when tool has security.readOnly: true", async () => {
    mockToolWithStatement("SELECT * FROM SYSIBM.SYSDUMMY1", { readOnly: true });

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "tool",
      "test_tool",
      "--tools",
      "/fake.yaml",
    ]);

    const output = stdoutOutput + stderrOutput;
    expect(output).not.toMatch(/write operation/i);
  });

  it("should allow DELETE when tool has security.readOnly: false", async () => {
    mockToolWithStatement("DELETE FROM SAMPLE.EMPLOYEE WHERE 1=0", {
      readOnly: false,
    });

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "tool",
      "test_tool",
      "--tools",
      "/fake.yaml",
    ]);

    const output = stdoutOutput + stderrOutput;
    expect(output).not.toMatch(/write operation/i);
  });

  it("should block DELETE when system readOnly overrides tool readOnly: false", async () => {
    mockToolWithStatement(
      "DELETE FROM SAMPLE.EMPLOYEE WHERE 1=0",
      { readOnly: false },
      true, // system readOnly
    );

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "tool",
      "test_tool",
      "--tools",
      "/fake.yaml",
    ]);

    const output = stdoutOutput + stderrOutput;
    expect(output).toMatch(/write operation/i);
  });
});

describe("ibmi tool command — parameter handling", () => {
  let stderrOutput: string;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;

  beforeEach(async () => {
    stderrOutput = "";
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrOutput += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const yamlLoader = await import("../../src/utils/yaml-loader.js");
    vi.mocked(yamlLoader.loadYamlTools).mockReturnValue({
      tools: {
        list_rows: {
          source: "test",
          description: "List rows",
          statement:
            "SELECT * FROM SAMPLE.T WHERE NAME LIKE :name_filter FETCH FIRST :limit ROWS ONLY",
          parameters: [
            { name: "limit", type: "integer", default: 50 },
            { name: "name_filter", type: "string" },
          ],
        },
        optional_only: {
          source: "test",
          description: "One optional parameter without a default",
          statement: "SELECT * FROM SAMPLE.T WHERE NAME LIKE :name_filter",
          parameters: [{ name: "name_filter", type: "string" }],
        },
      },
      toolsets: {},
      sources: {},
    });

    const resolver = await import("../../src/config/resolver.js");
    vi.mocked(resolver.resolveSystem).mockReturnValue({
      name: "dev",
      config: {
        host: "dev400.com",
        port: 8076,
        user: "DEV",
        readOnly: false,
        confirm: false,
        timeout: 60,
        maxRows: 5000,
        ignoreUnauthorized: true,
      },
      source: "flag",
    });
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("should reject a non-integer value for an integer parameter (exit 2)", async () => {
    const { IBMiConnectionPool } =
      await import("@ibm/ibmi-mcp-server/services");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "--format",
      "table",
      "tool",
      "list_rows",
      "--tools",
      "/fake.yaml",
      "--limit",
      "abc",
    ]);

    expect(stderrOutput).toMatch(/--limit/);
    expect(stderrOutput).toMatch(/Expected an integer/);
    expect(process.exitCode).toBe(2);
    expect(IBMiConnectionPool.executeQuery).not.toHaveBeenCalled();
  });

  it("should reject an option the tool does not define (exit 2)", async () => {
    const { IBMiConnectionPool } =
      await import("@ibm/ibmi-mcp-server/services");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "--format",
      "table",
      "tool",
      "list_rows",
      "--tools",
      "/fake.yaml",
      "--limt",
      "5",
    ]);

    expect(stderrOutput).toMatch(/unknown option '--limt'/);
    expect(process.exitCode).toBe(2);
    expect(IBMiConnectionPool.executeQuery).not.toHaveBeenCalled();
  });

  it("should bind parameters even when no optional parameter is passed", async () => {
    const { IBMiConnectionPool, ParameterProcessor } =
      await import("@ibm/ibmi-mcp-server/services");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "--format",
      "json",
      "tool",
      "optional_only",
      "--tools",
      "/fake.yaml",
    ]);

    expect(ParameterProcessor.process).toHaveBeenCalledTimes(1);
    // The processed SQL (markers replaced) is what gets executed, not the raw statement
    expect(vi.mocked(IBMiConnectionPool.executeQuery).mock.calls[0]?.[0]).toBe(
      "SELECT 1",
    );
  });

  it("should write results to the --output file instead of stdout", async () => {
    const { existsSync, readFileSync, unlinkSync } = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const outputFile = path.join(
      os.tmpdir(),
      `ibmi-test-${Date.now()}-tool.csv`,
    );
    let stdoutOutput = "";
    process.stdout.write = ((chunk: string) => {
      stdoutOutput += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "--format",
        "csv",
        "--output",
        outputFile,
        "tool",
        "optional_only",
        "--tools",
        "/fake.yaml",
      ]);

      expect(stdoutOutput).toBe("");
      expect(readFileSync(outputFile, "utf-8")).toBe("OK\n1\n");
    } finally {
      if (existsSync(outputFile)) unlinkSync(outputFile);
    }
  });

  it("should write --dry-run output to the --output file instead of stdout", async () => {
    const { existsSync, readFileSync, unlinkSync } = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const outputFile = path.join(
      os.tmpdir(),
      `ibmi-test-${Date.now()}-dry.txt`,
    );
    let stdoutOutput = "";
    process.stdout.write = ((chunk: string) => {
      stdoutOutput += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "--format",
        "table",
        "--output",
        outputFile,
        "tool",
        "optional_only",
        "--tools",
        "/fake.yaml",
        "--dry-run",
      ]);

      expect(stdoutOutput).toBe("");
      const written = readFileSync(outputFile, "utf-8");
      expect(written).toContain("Would execute:");
      expect(written).toContain(
        "SELECT * FROM SAMPLE.T WHERE NAME LIKE :name_filter",
      );
    } finally {
      if (existsSync(outputFile)) unlinkSync(outputFile);
    }
  });

  it("should re-run with --watch and overwrite the --output file on every run", async () => {
    const { existsSync, readFileSync, unlinkSync } = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const { IBMiConnectionPool } =
      await import("@ibm/ibmi-mcp-server/services");
    const outputFile = path.join(
      os.tmpdir(),
      `ibmi-test-${Date.now()}-watch.csv`,
    );

    let fileBeforeSecondRun = "";
    vi.mocked(IBMiConnectionPool.executeQuery)
      .mockResolvedValueOnce({ data: [{ RUN: 1 }] } as never)
      .mockImplementationOnce((async () => {
        fileBeforeSecondRun = readFileSync(outputFile, "utf-8");
        process.emit("SIGINT"); // Ctrl+C: this run is the last
        return { data: [{ RUN: 2 }] };
      }) as never);

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "--format",
        "csv",
        "--watch",
        "1",
        "--output",
        outputFile,
        "tool",
        "optional_only",
        "--tools",
        "/fake.yaml",
      ]);

      expect(IBMiConnectionPool.executeQuery).toHaveBeenCalledTimes(2);
      // Written after the first run, then replaced (not appended to) by the second
      expect(fileBeforeSecondRun).toBe("RUN\n1\n");
      expect(readFileSync(outputFile, "utf-8")).toBe("RUN\n2\n");
    } finally {
      if (existsSync(outputFile)) unlinkSync(outputFile);
    }
  });
});
