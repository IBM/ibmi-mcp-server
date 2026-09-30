/**
 * `ibmi sql --system a,b`: every system goes through the server's
 * execute_sql guardrail module, with PARSE_STATEMENT on that system's pool.
 * SourceManager is mocked; the guardrails are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExitCode } from "../../src/utils/exit-codes";

const mocks = vi.hoisted(() => ({
  registerSource: vi.fn(),
  executeQuery: vi.fn(),
  promptPassword: vi.fn(),
  config: { systems: {} as Record<string, unknown> },
}));

vi.mock("@ibm/ibmi-mcp-server/services", () => ({
  SourceManager: vi.fn().mockImplementation(() => ({
    registerSource: mocks.registerSource,
    executeQuery: mocks.executeQuery,
    closeAllSources: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../../src/config/credentials.js", () => ({
  resolvePassword: vi.fn().mockResolvedValue("pw"),
  promptPassword: mocks.promptPassword,
}));

vi.mock("../../src/config/loader.js", () => ({
  loadConfig: vi.fn(() => mocks.config),
}));

import { createProgram } from "../../src/index";

function sys(extra: Record<string, unknown> = {}) {
  return {
    host: "h.example.com",
    port: 8076,
    user: "U",
    readOnly: false,
    confirm: false,
    timeout: 60,
    maxRows: 100,
    ignoreUnauthorized: true,
    ...extra,
  };
}

/** PARSE_STATEMENT rows per system, keyed by source name. */
let parseRows: Record<string, unknown[]> = {};

function isParseStatement(query: string): boolean {
  return query.includes("QSYS2.PARSE_STATEMENT");
}

/** Statements actually executed (not PARSE_STATEMENT), per source. */
function executed(): Array<[string, string]> {
  return mocks.executeQuery.mock.calls
    .filter(([, query]) => !isParseStatement(query as string))
    .map(([source, query]) => [source as string, query as string]);
}

async function run(
  args: string[],
): Promise<{ json: Record<string, unknown>; exitCode: number | undefined }> {
  const out: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node",
      "ibmi",
      "sql",
      ...args,
      "--format",
      "json",
    ]);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return {
    json: JSON.parse(out.join("")) as Record<string, unknown>,
    exitCode: process.exitCode as number | undefined,
  };
}

type SystemRow = { system: string; error?: string };

describe("ibmi sql multi-system guardrails", () => {
  beforeEach(() => {
    mocks.registerSource.mockReset().mockResolvedValue(undefined);
    mocks.promptPassword.mockReset();
    mocks.executeQuery
      .mockReset()
      .mockImplementation(async (source: string, query: string) =>
        isParseStatement(query)
          ? { data: parseRows[source] ?? [], is_done: true }
          : { data: [{ A: 1 }] },
      );
    parseRows = {};
    mocks.config = { systems: { dev: sys(), prod: sys() } };
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("approves a plain query on the quick path and runs the limited text", async () => {
    const { json, exitCode } = await run([
      "SELECT * FROM QSYS2.SYSTABLES;",
      "--system",
      "dev,prod",
    ]);

    expect(exitCode).toBeUndefined();
    expect(json["ok"]).toBe(true);
    expect(executed()).toEqual([
      ["dev", "SELECT * FROM QSYS2.SYSTABLES FETCH FIRST 100 ROWS ONLY"],
      ["prod", "SELECT * FROM QSYS2.SYSTABLES FETCH FIRST 100 ROWS ONLY"],
    ]);
    expect(
      mocks.executeQuery.mock.calls.some(([, q]) => isParseStatement(q)),
    ).toBe(false);
  });

  it("sets JDBC access from the mode on every system's pool", async () => {
    await run(["SELECT 1 FROM SYSIBM.SYSDUMMY1", "--system", "dev,prod"]);
    for (const [, source] of mocks.registerSource.mock.calls) {
      expect(source["jdbc-options"]).toEqual({ access: "read call" });
    }

    mocks.registerSource.mockClear();
    await run([
      "DELETE FROM MYLIB.T",
      "--system",
      "dev,prod",
      "--access",
      "write",
    ]);
    for (const [, source] of mocks.registerSource.mock.calls) {
      expect(source["jdbc-options"]).toEqual({ access: "all" });
    }
    // write never calls PARSE_STATEMENT
    expect(
      mocks.executeQuery.mock.calls.some(([, q]) => isParseStatement(q)),
    ).toBe(false);
  });

  it("verifies an uncertain statement with PARSE_STATEMENT on each system and rejects writes", async () => {
    const sql = "SELECT * FROM FINAL TABLE (INSERT INTO MYLIB.T VALUES (1))";
    const insertRows = [
      {
        NAME_TYPE: "TABLE",
        SCHEMA: "MYLIB",
        NAME: "T",
        USAGE_TYPE: "TARGET TABLE",
        SQL_STATEMENT_TYPE: "QUERY",
      },
    ];
    parseRows = { dev: insertRows, prod: insertRows };

    const { json, exitCode } = await run([sql, "--system", "dev,prod"]);

    expect(exitCode).toBe(ExitCode.SECURITY);
    const parseCalls = mocks.executeQuery.mock.calls.filter(([, q]) =>
      isParseStatement(q),
    );
    expect(parseCalls.map(([source]) => source).sort()).toEqual([
      "dev",
      "prod",
    ]);
    expect(parseCalls[0]![2]![0]).toBe(`${sql} FETCH FIRST 100 ROWS ONLY`);
    // All PARSE_STATEMENT rows are fetched, not the driver's default 100
    expect(parseCalls[0]![5]).toBe(10_000);
    expect(executed()).toEqual([]);
    for (const row of json["systems"] as SystemRow[]) {
      expect(row.error).toContain(
        "execute_sql read guardrail rejected the statement",
      );
      expect(row.error).toContain("MYLIB.T is used as TARGET TABLE");
    }
  });

  it("applies each system's forbidden keywords", async () => {
    mocks.config = {
      systems: { dev: sys(), prod: sys({ forbiddenKeywords: ["SYSTABLES"] }) },
    };

    const { json, exitCode } = await run([
      "SELECT * FROM QSYS2.SYSTABLES",
      "--system",
      "dev,prod",
    ]);

    expect(exitCode).toBe(ExitCode.SECURITY);
    const systems = json["systems"] as SystemRow[];
    expect(systems.find((s) => s.system === "dev")?.error).toBeUndefined();
    expect(systems.find((s) => s.system === "prod")?.error).toContain(
      'matches forbidden keyword pattern "SYSTABLES"',
    );
    expect(executed().map(([source]) => source)).toEqual(["dev"]);
  });

  it("refuses a mode above any target system's ceiling before connecting", async () => {
    mocks.config = { systems: { dev: sys(), prod: sys({ access: "read" }) } };

    const { json, exitCode } = await run([
      "CALL MYLIB.P()",
      "--system",
      "dev,prod",
      "--access",
      "read-call",
    ]);

    expect(exitCode).toBe(ExitCode.SECURITY);
    expect((json["error"] as { message: string }).message).toContain(
      'above the ceiling of system "prod" (access: read',
    );
    expect(mocks.registerSource).not.toHaveBeenCalled();
  });

  it("honors a system's confirm setting", async () => {
    mocks.config = { systems: { dev: sys(), prod: sys({ confirm: true }) } };
    mocks.promptPassword.mockResolvedValue("n");
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    try {
      const { json } = await run([
        "SELECT 1 FROM SYSIBM.SYSDUMMY1",
        "--system",
        "dev,prod",
      ]);
      expect(mocks.promptPassword).toHaveBeenCalledWith(
        "Execute on [prod]? (y/N) ",
      );
      expect((json["error"] as { message: string }).message).toBe(
        "Execution cancelled by user",
      );
      expect(mocks.executeQuery).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });
});
