/**
 * Exit status of commands that report a failure as rows instead of throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProgram } from "../../src/program.js";

// describe.ts imports the tools module statically, so the mock factory runs
// before this file's top-level code
const { validateQuery, generateSql } = vi.hoisted(() => ({
  validateQuery: vi.fn(),
  generateSql: vi.fn(),
}));

vi.mock("../../src/config/resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/config/resolver.js")>();
  return { ...actual, resolveSystem: vi.fn() };
});

vi.mock("../../src/utils/connection.js", () => ({
  connectSystem: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@ibm/ibmi-mcp-server/tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ibm/ibmi-mcp-server/tools")>();
  return {
    ...actual,
    validateQueryLogic: validateQuery,
    generateSqlTool: { logic: generateSql },
  };
});

describe("exit status for failures reported as rows", () => {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdoutOutput: string;

  async function run(...args: string[]): Promise<void> {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync(["node", "ibmi", "--format", "json", ...args]);
  }

  beforeEach(async () => {
    stdoutOutput = "";
    process.stdout.write = ((chunk: string) => {
      stdoutOutput += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

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

  describe("ibmi validate", () => {
    it("should exit 3 when the statement cannot be parsed", async () => {
      validateQuery.mockResolvedValue({ success: true, data: [], rowCount: 0 });

      await run("validate", "SELEC 1");

      // The report is still rendered
      expect(JSON.parse(stdoutOutput).data[0]).toMatchObject({
        CHECK: "Syntax",
        STATUS: "FAIL",
      });
      expect(process.exitCode).toBe(3);
    });

    it("should exit 3 when a referenced table does not exist", async () => {
      validateQuery.mockResolvedValue({
        success: true,
        data: [{ SQL_STATEMENT_TYPE: "QUERY" }],
        rowCount: 1,
        objectValidation: {
          tables: { valid: [], invalid: ["SAMPLE.NOPE"] },
          columns: { valid: [], invalid: [] },
          routines: { valid: [], invalid: [] },
        },
      });

      await run("validate", "SELECT * FROM SAMPLE.NOPE");

      expect(process.exitCode).toBe(3);
    });

    it("should exit 0 when every check passes", async () => {
      validateQuery.mockResolvedValue({
        success: true,
        data: [{ SQL_STATEMENT_TYPE: "QUERY" }],
        rowCount: 1,
      });

      await run("validate", "SELECT 1 FROM SYSIBM.SYSDUMMY1");

      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("ibmi describe", () => {
    const failure = {
      success: false,
      error: { code: "-32010", message: "No SQL DDL generated" },
    };

    it("should exit 3 when no object could be described", async () => {
      generateSql.mockResolvedValue(failure);

      await run("describe", "SAMPLE.A,SAMPLE.B");

      expect(JSON.parse(stdoutOutput).data).toHaveLength(2);
      expect(process.exitCode).toBe(3);
    });

    it("should exit 0 when at least one object was described", async () => {
      generateSql
        .mockResolvedValueOnce({
          success: true,
          sql: "CREATE TABLE SAMPLE.A (C INT)",
        })
        .mockResolvedValueOnce(failure);

      await run("describe", "SAMPLE.A,SAMPLE.B");

      expect(process.exitCode).toBeUndefined();
    });

    it("should exit 2 for a malformed object reference", async () => {
      await run("describe", "A.B.C");

      expect(generateSql).not.toHaveBeenCalled();
      expect(JSON.parse(stdoutOutput).error.code).toBe("USAGE_ERROR");
      expect(process.exitCode).toBe(2);
    });
  });
});
