import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "fs";
import os from "os";
import path from "path";
import { createProgram } from "../../src/program";
import type { ResolvedSystem } from "../../src/config/types";

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
      ) => Promise<{ data: Record<string, unknown>[] }>,
    ) => {
      const results = [];
      for (const sys of systems) {
        const result = await action(sys.name, mgr, {});
        results.push({
          system: sys.name,
          host: sys.config.host,
          data: result.data,
          rowCount: result.data.length,
          elapsedMs: 1,
        });
      }
      return results;
    },
  ),
}));

function makeSystem(name: string): ResolvedSystem {
  return {
    name,
    config: {
      host: `${name}400.com`,
      port: 8076,
      user: "USER",
      readOnly: false,
      confirm: false,
      timeout: 60,
      maxRows: 5000,
      ignoreUnauthorized: true,
    },
    source: "flag",
  };
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
});
