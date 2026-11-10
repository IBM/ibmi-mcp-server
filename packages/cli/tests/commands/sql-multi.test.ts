import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "fs";
import os from "os";
import path from "path";
import { createProgram } from "../../src/program.js";
import type { ResolvedSystem } from "../../src/config/types.js";

const mgr = {
  executeQuery: vi.fn(),
  executeQueryWithPagination: vi.fn(),
};

vi.mock("../../src/config/resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/config/resolver.js")>();
  return { ...actual, resolveSystems: vi.fn() };
});

vi.mock("../../src/utils/multi-connection.js", () => ({
  // Run the action once per system against the fake manager
  executeMultiSystem: vi.fn(
    async (
      systems: ResolvedSystem[],
      action: (
        sourceName: string,
        manager: typeof mgr,
        ctx: unknown,
      ) => Promise<{
        data: Record<string, unknown>[];
        meta?: { hasMore?: boolean };
      }>,
    ) => {
      const results = [];
      for (const sys of systems) {
        const base = { system: sys.name, host: sys.config.host, elapsedMs: 1 };
        try {
          const result = await action(sys.name, mgr, {});
          results.push({
            ...base,
            data: result.data,
            rowCount: result.data.length,
            hasMore: result.meta?.hasMore === true,
          });
        } catch (err) {
          results.push({
            ...base,
            data: [],
            rowCount: 0,
            error: (err as Error).message,
          });
        }
      }
      return results;
    },
  ),
}));

vi.mock("../../src/config/credentials.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/config/credentials.js")>();
  return { ...actual, promptLine: vi.fn() };
});

function makeSystem(name: string, confirm = false): ResolvedSystem {
  return {
    name,
    config: {
      host: `${name}400.com`,
      port: 8076,
      user: "USER",
      readOnly: false,
      confirm,
      timeout: 60,
      maxRows: 5000,
      ignoreUnauthorized: true,
    },
    source: "flag",
  };
}

async function runSql(...args: string[]): Promise<void> {
  const program = createProgram();
  program.exitOverride();
  await program.parseAsync([
    "node", "ibmi", "--system", "dev,prod", ...args,
  ]);
}

describe("ibmi sql — multiple systems", () => {
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

    const resolver = await import("../../src/config/resolver.js");
    vi.mocked(resolver.resolveSystems).mockReturnValue([
      makeSystem("dev"),
      makeSystem("prod"),
    ]);
    mgr.executeQueryWithPagination.mockResolvedValue({
      success: true,
      data: [{ EMPNO: "100" }],
      truncated: false,
    });
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("should paginate each system instead of stopping at the driver's first page", async () => {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "ibmi", "--system", "dev,prod", "--format", "csv",
      "sql", "SELECT EMPNO FROM SAMPLE.EMPLOYEE", "--limit", "500",
    ]);

    expect(mgr.executeQuery).not.toHaveBeenCalled();
    expect(mgr.executeQueryWithPagination).toHaveBeenCalledTimes(2);
    expect(mgr.executeQueryWithPagination.mock.calls[0]?.slice(0, 2)).toEqual([
      "dev",
      "SELECT EMPNO FROM SAMPLE.EMPLOYEE FETCH FIRST 500 ROWS ONLY",
    ]);
    expect(stdoutOutput).toBe("SYSTEM,EMPNO\ndev,100\nprod,100\n");
  });

  it("should honor --output", async () => {
    const outputFile = path.join(
      os.tmpdir(),
      `ibmi-test-${Date.now()}-multi-sql.csv`,
    );

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node", "ibmi", "--system", "dev,prod", "--format", "csv",
        "--output", outputFile, "sql", "SELECT EMPNO FROM SAMPLE.EMPLOYEE",
      ]);

      expect(stdoutOutput).toBe("");
      expect(readFileSync(outputFile, "utf-8")).toBe(
        "SYSTEM,EMPNO\ndev,100\nprod,100\n",
      );
    } finally {
      if (existsSync(outputFile)) unlinkSync(outputFile);
    }
  });

  it("should exit 1 when any system fails", async () => {
    mgr.executeQueryWithPagination
      .mockResolvedValueOnce({ success: true, data: [{ EMPNO: "100" }] })
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.2:8076"));

    await runSql("--format", "json", "sql", "SELECT EMPNO FROM SAMPLE.EMPLOYEE");

    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.ok).toBe(false);
    expect(parsed.meta.systems_failed).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it("should exit 0 when every system succeeds", async () => {
    await runSql("--format", "json", "sql", "SELECT EMPNO FROM SAMPLE.EMPLOYEE");

    expect(JSON.parse(stdoutOutput).ok).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("should report truncation per system", async () => {
    mgr.executeQueryWithPagination
      // dev: the service-layer row cap was hit
      .mockResolvedValueOnce({
        success: true,
        data: [{ EMPNO: "100" }],
        truncated: true,
      })
      .mockResolvedValueOnce({
        success: true,
        data: [{ EMPNO: "200" }],
        truncated: false,
      });

    await runSql("--format", "json", "sql", "SELECT EMPNO FROM SAMPLE.EMPLOYEE");

    const { systems } = JSON.parse(stdoutOutput);
    expect(systems[0]).toMatchObject({ system: "dev", hasMore: true });
    expect(systems[1]).not.toHaveProperty("hasMore");
  });

  it("should enforce --limit per system on the fetched rows and flag it in the table footer", async () => {
    mgr.executeQueryWithPagination.mockResolvedValue({
      success: true,
      data: [{ EMPNO: "100" }, { EMPNO: "200" }, { EMPNO: "300" }],
      truncated: false,
    });

    // LIMIT keeps the statement from being rewritten with FETCH FIRST
    const sql = "SELECT EMPNO FROM SAMPLE.EMPLOYEE LIMIT 10";
    await runSql("--format", "table", "sql", sql, "--limit", "2");

    expect(mgr.executeQueryWithPagination.mock.calls[0]?.[1]).toBe(sql);
    expect(stdoutOutput).not.toContain("300");
    expect(stdoutOutput).toContain("[dev] 2 rows (truncated)");
    expect(stdoutOutput).toContain("[prod] 2 rows (truncated)");
  });

  describe("systems marked confirm: true", () => {
    const originalIsTTY = process.stdin.isTTY;

    function setStdinTTY(value: boolean): void {
      Object.defineProperty(process.stdin, "isTTY", {
        value,
        configurable: true,
      });
    }

    beforeEach(async () => {
      const resolver = await import("../../src/config/resolver.js");
      vi.mocked(resolver.resolveSystems).mockReturnValue([
        makeSystem("dev", true),
        makeSystem("prod", true),
      ]);
    });

    afterEach(() => {
      setStdinTTY(originalIsTTY);
    });

    it("should refuse to run non-interactively without --yes (exit 2)", async () => {
      setStdinTTY(false);
      const { promptLine } = await import("../../src/config/credentials.js");

      await runSql("--format", "json", "sql", "SELECT 1 FROM SYSIBM.SYSDUMMY1");

      expect(mgr.executeQueryWithPagination).not.toHaveBeenCalled();
      expect(promptLine).not.toHaveBeenCalled();
      const parsed = JSON.parse(stdoutOutput);
      expect(parsed.error.code).toBe("USAGE_ERROR");
      expect(parsed.error.message).toContain("[dev, prod]");
      expect(parsed.error.message).toContain("--yes");
      expect(process.exitCode).toBe(2);
    });

    it("should run without a prompt when --yes is passed", async () => {
      setStdinTTY(false);
      const { promptLine } = await import("../../src/config/credentials.js");

      await runSql(
        "--format", "json", "sql", "SELECT 1 FROM SYSIBM.SYSDUMMY1", "--yes",
      );

      expect(promptLine).not.toHaveBeenCalled();
      expect(mgr.executeQueryWithPagination).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBeUndefined();
    });

    it("should prompt once for all systems and run on 'y'", async () => {
      setStdinTTY(true);
      const { promptLine } = await import("../../src/config/credentials.js");
      vi.mocked(promptLine).mockResolvedValue("y");

      await runSql("--format", "json", "sql", "SELECT 1 FROM SYSIBM.SYSDUMMY1");

      expect(promptLine).toHaveBeenCalledTimes(1);
      expect(promptLine).toHaveBeenCalledWith("Execute on [dev, prod]? (y/N) ");
      expect(mgr.executeQueryWithPagination).toHaveBeenCalledTimes(2);
    });

    it("should not run when the prompt is declined", async () => {
      setStdinTTY(true);
      const { promptLine } = await import("../../src/config/credentials.js");
      vi.mocked(promptLine).mockResolvedValue("n");

      await runSql("--format", "json", "sql", "SELECT 1 FROM SYSIBM.SYSDUMMY1");

      expect(mgr.executeQueryWithPagination).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });
});
