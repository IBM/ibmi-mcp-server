/**
 * `ibmi sql` single-system guardrail mode selection: --access, ceilings and
 * exit codes. execute_sql itself is mocked; its guardrails are tested in the
 * server package and in sql-multi.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExitCode } from "../../src/utils/exit-codes";

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  logic: vi.fn(),
}));

vi.mock("@ibm/ibmi-mcp-server/tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ibm/ibmi-mcp-server/tools")>();
  return {
    ...actual,
    configureExecuteSqlTool: mocks.configure,
    executeSqlTool: { ...actual.executeSqlTool, logic: mocks.logic },
  };
});

vi.mock("../../src/config/loader.js", () => ({
  loadConfig: vi.fn(() => ({
    systems: {
      dev: {
        host: "dev.example.com",
        port: 8076,
        user: "DEV",
        readOnly: false,
        confirm: false,
        timeout: 60,
        maxRows: 50,
        ignoreUnauthorized: true,
        forbiddenKeywords: ["QSYS2.HTTP_*"],
      },
      prod: {
        host: "prod.example.com",
        port: 8076,
        user: "PROD",
        access: "read-call",
        readOnly: false,
        confirm: false,
        timeout: 60,
        maxRows: 50,
        ignoreUnauthorized: true,
      },
    },
  })),
}));

vi.mock("../../src/utils/connection.js", () => ({
  connectSystem: vi.fn(() => Promise.resolve(async () => {})),
}));

import { createProgram } from "../../src/index";

async function run(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  try {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync(["node", "ibmi", "sql", ...args]);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  const exitCode = process.exitCode as number | undefined;
  return { stdout: out.join(""), stderr: err.join(""), exitCode };
}

describe("ibmi sql --access (single system)", () => {
  beforeEach(() => {
    mocks.configure.mockReset();
    mocks.logic.mockReset();
    mocks.configure.mockImplementation(
      (cfg: { security: { access: string } }) => cfg.security.access,
    );
    mocks.logic.mockResolvedValue({
      success: true,
      data: [{ A: 1 }],
      rowCount: 1,
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    delete process.env["IBMI_EXECUTE_SQL_ACCESS"];
  });

  it("registers --access and the deprecated flags", () => {
    const sql = createProgram().commands.find((c) => c.name() === "sql");
    const longs = sql?.options.map((o) => o.long);
    expect(longs).toContain("--access");
    expect(longs).toContain("--read-only");
    expect(longs).toContain("--no-read-only");
  });

  it("defaults to read and passes the system's forbidden keywords", async () => {
    const { exitCode } = await run([
      "SELECT * FROM QSYS2.SYSTABLES;",
      "--system",
      "dev",
      "--format",
      "json",
    ]);

    expect(exitCode).toBeUndefined();
    expect(mocks.configure).toHaveBeenCalledWith({
      enabled: true,
      security: { access: "read", forbiddenKeywords: ["QSYS2.HTTP_*"] },
    });
    // Row limit is applied before execute_sql validates the statement
    expect(mocks.logic.mock.calls[0]![0]).toEqual({
      sql: "SELECT * FROM QSYS2.SYSTABLES FETCH FIRST 50 ROWS ONLY",
    });
  });

  it("requests the --access mode", async () => {
    await run(["CALL MYLIB.P()", "--system", "dev", "--access", "read-call"]);
    expect(mocks.configure.mock.calls[0]![0].security.access).toBe("read-call");
    expect(mocks.logic.mock.calls[0]![0]).toEqual({ sql: "CALL MYLIB.P()" });
  });

  it("maps the deprecated --no-read-only to write with a notice", async () => {
    const { stderr } = await run([
      "DELETE FROM MYLIB.T",
      "--system",
      "dev",
      "--no-read-only",
    ]);
    expect(stderr).toContain("deprecated; use --access write");
    expect(mocks.configure.mock.calls[0]![0].security.access).toBe("write");
  });

  it("exits 2 on an unrecognized --access value without connecting", async () => {
    const { stderr, exitCode } = await run([
      "SELECT 1 FROM SYSIBM.SYSDUMMY1",
      "--access",
      "all",
    ]);
    expect(exitCode).toBe(ExitCode.USAGE);
    expect(stderr).toContain('Invalid --access value: "all"');
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it("exits 4 when --access is above the system's ceiling", async () => {
    const { stdout, exitCode } = await run([
      "SELECT 1 FROM SYSIBM.SYSDUMMY1",
      "--system",
      "prod",
      "--access",
      "write",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(ExitCode.SECURITY);
    const parsed = JSON.parse(stdout);
    expect(parsed.error.code).toBe("SECURITY_VIOLATION");
    expect(parsed.error.message).toContain(
      'above the ceiling of system "prod" (access: read-call',
    );
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.logic).not.toHaveBeenCalled();
  });

  it("exits 4 naming IBMI_EXECUTE_SQL_ACCESS when the server lowers the mode", async () => {
    process.env["IBMI_EXECUTE_SQL_ACCESS"] = "read";
    mocks.configure.mockReturnValue("read");
    const { stdout, exitCode } = await run([
      "CALL MYLIB.P()",
      "--system",
      "dev",
      "--access",
      "read-call",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(ExitCode.SECURITY);
    expect(JSON.parse(stdout).error.message).toContain(
      "Guardrail mode 'read-call' is above the ceiling IBMI_EXECUTE_SQL_ACCESS=read",
    );
    expect(mocks.logic).not.toHaveBeenCalled();
  });

  it("exits 4 on a guardrail rejection", async () => {
    mocks.logic.mockRejectedValue(
      Object.assign(
        new Error(
          "execute_sql read guardrail rejected the statement: statement type CALL is not allowed. The read-call guardrail mode allows it.",
        ),
        {
          code: -32007,
          details: {
            access: "read",
            rule: "statement-type",
            offending: "CALL",
          },
        },
      ),
    );
    const { stdout, exitCode } = await run([
      "CALL MYLIB.P()",
      "--system",
      "dev",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(ExitCode.SECURITY);
    expect(JSON.parse(stdout).error.code).toBe("SECURITY_VIOLATION");
  });
});
