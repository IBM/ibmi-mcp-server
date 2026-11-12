import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProgram } from "../../src/program.js";
import type { ResolvedSystem } from "../../src/config/types.js";

// describe.ts imports the tools module statically, so the mock factory runs
// before this file's top-level code
const executeSql = vi.hoisted(() => vi.fn());

vi.mock("../../src/config/resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/config/resolver.js")>();
  return { ...actual, resolveSystem: vi.fn() };
});

vi.mock("../../src/utils/connection.js", () => ({
  connectSystem: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("../../src/config/credentials.js", () => ({
  promptLine: vi.fn(),
}));

vi.mock("@ibm/ibmi-mcp-server/tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ibm/ibmi-mcp-server/tools")>();
  return {
    ...actual,
    configureExecuteSqlTool: vi.fn(),
    executeSqlTool: { logic: executeSql },
  };
});

const devSystem = (confirm: boolean): ResolvedSystem => ({
  name: "dev",
  config: {
    host: "dev400.com",
    port: 8076,
    user: "DEV",
    readOnly: false,
    confirm,
    timeout: 60,
    maxRows: 5000,
    ignoreUnauthorized: true,
  },
  source: "flag",
});

async function resolveTo(system: ResolvedSystem): Promise<void> {
  const resolver = await import("../../src/config/resolver.js");
  vi.mocked(resolver.resolveSystem).mockReturnValue(system);
}

describe("ibmi sql — single system execution", () => {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdoutOutput: string;

  beforeEach(async () => {
    stdoutOutput = "";
    process.stdout.write = ((chunk: string) => {
      stdoutOutput += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    await resolveTo(devSystem(false));
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("should report hasMore when the appended FETCH FIRST cut the result", async () => {
    // The server honours FETCH FIRST 3: one row more than the limit exists.
    executeSql.mockResolvedValue({
      success: true,
      data: [{ N: 1 }, { N: 2 }, { N: 3 }],
      rowCount: 3,
    });

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "--format",
      "json",
      "sql",
      "SELECT N FROM T",
      "--limit",
      "2",
    ]);

    expect(executeSql.mock.calls[0]?.[0]).toEqual({
      sql: "SELECT N FROM T FETCH FIRST 3 ROWS ONLY",
    });
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.data).toEqual([{ N: 1 }, { N: 2 }]);
    expect(parsed.meta).toMatchObject({ rows: 2, hasMore: true });
  });

  it("should not report hasMore when the result fits the limit", async () => {
    executeSql.mockResolvedValue({
      success: true,
      data: [{ N: 1 }, { N: 2 }],
      rowCount: 2,
    });

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "--format",
      "json",
      "sql",
      "SELECT N FROM T",
      "--limit",
      "2",
    ]);

    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.data).toEqual([{ N: 1 }, { N: 2 }]);
    expect(parsed.meta).toMatchObject({ rows: 2, hasMore: false });
  });

  it("should enforce --limit on the fetched rows when the SQL cannot take FETCH FIRST", async () => {
    executeSql.mockResolvedValue({
      success: true,
      data: [{ N: 1 }, { N: 2 }, { N: 3 }],
      rowCount: 3,
    });

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "--format",
      "json",
      "sql",
      "SELECT N FROM T LIMIT 10",
      "--limit",
      "2",
    ]);

    // The statement is not rewritten into "... LIMIT 10 FETCH FIRST 2 ROWS ONLY"
    expect(executeSql.mock.calls[0]?.[0]).toEqual({
      sql: "SELECT N FROM T LIMIT 10",
    });
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.data).toEqual([{ N: 1 }, { N: 2 }]);
    expect(parsed.meta).toMatchObject({ rows: 2, hasMore: true });
    expect(process.exitCode).toBeUndefined();
  });

  describe("a system marked confirm: true, on a terminal", () => {
    const originalIsTTY = process.stdin.isTTY;
    const setStdinTTY = (value: boolean | undefined) =>
      Object.defineProperty(process.stdin, "isTTY", {
        value,
        configurable: true,
      });
    const run = async (...extra: string[]) => {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "--format",
        "json",
        "sql",
        "SELECT 1 FROM SYSIBM.SYSDUMMY1",
        ...extra,
      ]);
    };

    beforeEach(async () => {
      setStdinTTY(true);
      executeSql.mockResolvedValue({ success: true, data: [], rowCount: 0 });
      await resolveTo(devSystem(true));
    });

    afterEach(() => {
      setStdinTTY(originalIsTTY);
    });

    it("should ask before executing, and not execute on anything but 'y'", async () => {
      const { promptLine } = await import("../../src/config/credentials.js");
      vi.mocked(promptLine).mockResolvedValue("n");

      await run();

      expect(promptLine).toHaveBeenCalledExactlyOnceWith(
        "Execute on [dev]? (y/N) ",
      );
      expect(executeSql).not.toHaveBeenCalled();
    });

    it("should execute without asking when --yes is passed", async () => {
      const { promptLine } = await import("../../src/config/credentials.js");

      await run("--yes");

      expect(promptLine).not.toHaveBeenCalled();
      expect(executeSql).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });
  });

  it("should exit 3 (SQL error), not 5, when a table named AUTHORS is not found", async () => {
    executeSql.mockResolvedValue({
      success: false,
      error: {
        code: "-32010",
        message:
          "Error in ExecuteQuery: [SQL0204] AUTHORS in SAMPLE type *FILE not found., 42704, -204",
      },
    });

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "--format",
      "json",
      "sql",
      "SELECT * FROM SAMPLE.AUTHORS",
    ]);

    expect(process.exitCode).toBe(3);
    expect(JSON.parse(stdoutOutput).error.code).toBe("SQL_ERROR");
  });
});
