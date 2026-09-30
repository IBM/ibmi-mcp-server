/**
 * @fileoverview Unit tests for the execute_sql guardrails: quick-path
 * decisions, slow-path rules over PARSE_STATEMENT rows, the two optional
 * gates, and the entry point's flow.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/utils/internal/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { config } from "../../../../src/config/index.js";
import { McpError } from "../../../../src/types-global/errors.js";
import { createRequestContext } from "../../../../src/utils/internal/requestContext.js";
import {
  enforceExecuteSqlGuardrails,
  evaluateParseStatementRows,
  parseStatementParams,
  quickPath,
  stripStatementTerminator,
  type ExecuteSqlGuardrailOptions,
} from "../../../../src/ibmi-mcp-server/utils/security/executeSqlGuardrail.js";
import type { ExecuteSqlAccess } from "../../../../src/ibmi-mcp-server/services/executeSqlAccess.js";

const QCMDEXC = ["QCMDEXC"];
const context = createRequestContext({ operation: "GuardrailTest" });

/** A PARSE_STATEMENT row. */
const row = (
  nameType: string,
  schema: string | null,
  name: string,
  usage = "QUERY",
  statementType = "QUERY",
) => ({
  NAME_TYPE: nameType,
  SCHEMA: schema,
  NAME: name,
  USAGE_TYPE: usage,
  SQL_STATEMENT_TYPE: statementType,
});
const table = row("TABLE", "QSYS2", "SYSTABLES");

describe("quickPath", () => {
  const verdict = (sql: string, access: "read" | "read-call" = "read") =>
    quickPath(sql, access, QCMDEXC).verdict;

  it.each([
    "SELECT * FROM QSYS2.SYSTABLES FETCH FIRST 5 ROWS ONLY",
    "select table_name from qsys2.systables where table_schema = ?",
    "WITH A AS (SELECT 1 AS X FROM SYSIBM.SYSDUMMY1) SELECT * FROM A",
    "VALUES 1",
    "VALUES CURRENT DATE",
    "SELECT * FROM TABLE(VALUES 1) X",
    `SELECT * FROM JSON_TABLE('{"a":1}', 'lax $' COLUMNS(A INT PATH 'lax $.a')) X`,
    "SELECT 'INSERT INTO T; QCMDEXC(' AS A FROM SYSIBM.SYSDUMMY1",
    "-- QCMDEXC( INSERT\nSELECT 1 FROM SYSIBM.SYSDUMMY1",
    'SELECT "TABLE_NAME" FROM QSYS2.SYSTABLES',
    "SELECT TABLE_NAME\r\nFROM QSYS2.SYSTABLES",
    "SELECT * FROM TABLE(QSYS2.ACTIVE_JOB_INFO()) X",
    "SELECT X'41', GX'0041' FROM SYSIBM.SYSDUMMY1",
    "SELECT 1 FROM SYSIBM.SYSDUMMY1 WHERE 1!=2",
  ])("approves in read: %s", (sql) => {
    expect(verdict(sql)).toBe("approve");
  });

  it.each([
    ["non-ASCII", "SELECT 'é' FROM SYSIBM.SYSDUMMY1"],
    ["U+3000 separator", "SELECT\u3000QCMDEXC('X') FROM T"],
    ["block comment", "SELECT /* c */ 1 FROM SYSIBM.SYSDUMMY1"],
    ["JDBC escape", "SELECT {fn UCASE('a')} FROM SYSIBM.SYSDUMMY1"],
    ["U& identifier", "SELECT QSYS2.U&\"\\0051CMDEXC\"('X') FROM T"],
    ["escaped quote in name", 'SELECT "A""B" FROM T'],
    ["special character in name", 'SELECT "A-B" FROM T'],
    ["semicolon", "SELECT 1 FROM T; DELETE FROM T"],
    ["unterminated string", "SELECT 'abc FROM T"],
    ["parenthesized query", "(SELECT 1 FROM T) UNION (SELECT 2 FROM T)"],
    ["label", "L1: SELECT 1 FROM T"],
    ["FINAL TABLE", "SELECT * FROM FINAL TABLE (INSERT INTO T VALUES 1)"],
    ["NEW TABLE", "SELECT * FROM new table (insert into T values 1)"],
    ["OLD TABLE", "SELECT * FROM OLD TABLE (X)"],
    ["UPDATE token", "SELECT * FROM T FOR UPDATE"],
    ["INSERT scalar", "SELECT INSERT('abc',1,1,'x') FROM T"],
    [
      "WITH ... INSERT",
      "WITH C AS (SELECT 1 A FROM T) INSERT INTO T2 SELECT A FROM C",
    ],
    ["SELECT INTO", "SELECT 1 INTO :H FROM T"],
    ["NEXT VALUE", "SELECT NEXT VALUE FOR S FROM T"],
    ["NEXTVAL", "SELECT NEXTVAL FOR S FROM T"],
    ["PREVIOUS VALUE", "SELECT PREVIOUS VALUE FOR S FROM T"],
    ["qualified forbidden function", "SELECT QSYS2.QCMDEXC('X') FROM T"],
    ["unqualified forbidden function", "SELECT qcmdexc('X') FROM T"],
    ["delimited forbidden function", "SELECT \"QCMDEXC  \"('X') FROM T"],
    [
      "CTE named like a forbidden function",
      "WITH QCMDEXC AS (SELECT 1 A FROM T) SELECT * FROM QCMDEXC",
    ],
    ["CALL inside a query", "VALUES (CALL P())"],
    // A word joined to a quote (Db2 starts a new token at the quote)
    [
      "keyword joined to a delimited function name",
      `SELECT DISTINCT"QCMDEXC"('DSPLIB QGPL') FROM SYSIBM.SYSDUMMY1`,
    ],
    [
      "operator joined to a delimited function name",
      `SELECT 1 FROM SYSIBM.SYSDUMMY1 WHERE 1 = 1 OR"QCMDEXC  "('x') = 0`,
    ],
    [
      "FOR joined to a delimited sequence name",
      `SELECT NEXT VALUE FOR"MYSEQ" FROM SYSIBM.SYSDUMMY1`,
    ],
    ["keyword joined to a string", "SELECT 1 FROM T WHERE A LIKE'x'"],
    ["unsplit punctuation", "SELECT A[1] FROM T"],
    ["delimited leading SELECT", '"SELECT" * FROM T'],
  ])("sends to the slow path in read: %s", (_label, sql) => {
    expect(verdict(sql)).toBe("slow");
  });

  it.each([
    ["CALL", "CALL QSYS2.QCMDEXC('X')", "read-call"],
    ["INSERT", "INSERT INTO T VALUES 1", "write"],
    ["DELETE", "delete from T", "write"],
    ["CREATE", "CREATE TABLE QTEMP.X (A INT)", "write"],
    ["SET", "SET SCHEMA QTEMP", "write"],
    ["COMMIT", "COMMIT", "write"],
  ])("rejects directly in read: %s", (offending, sql, lowestMode) => {
    const result = quickPath(sql, "read", QCMDEXC);
    expect(result).toEqual({
      verdict: "reject",
      rejection: expect.objectContaining({
        rule: "statement-type",
        offending,
        lowestMode,
      }),
    });
  });

  it("read-call approves CALL, functions and sequences", () => {
    expect(
      verdict("CALL QSYS2.GENERATE_SQL('T', 'L', 'TABLE')", "read-call"),
    ).toBe("approve");
    expect(verdict("SELECT QSYS2.QCMDEXC('X') FROM T", "read-call")).toBe(
      "approve",
    );
    expect(verdict("SELECT NEXT VALUE FOR S FROM T", "read-call")).toBe(
      "approve",
    );
  });

  it("read-call still routes data-change verbs and rejects DML", () => {
    expect(
      verdict(
        "CALL P((SELECT A FROM FINAL TABLE (INSERT INTO T VALUES 1)))",
        "read-call",
      ),
    ).toBe("slow");
    expect(
      verdict(
        "SELECT * FROM FINAL TABLE (INSERT INTO T VALUES 1)",
        "read-call",
      ),
    ).toBe("slow");
    expect(quickPath("UPDATE T SET A = 1", "read-call", QCMDEXC)).toMatchObject(
      {
        verdict: "reject",
        rejection: { offending: "UPDATE", lowestMode: "write" },
      },
    );
  });

  it("forbidden-function patterns support wildcards and SCHEMA.NAME", () => {
    expect(
      quickPath("SELECT QSYS2.HTTP_GET('u') FROM T", "read", ["HTTP_*"])
        .verdict,
    ).toBe("slow");
    expect(
      quickPath("SELECT SYSTOOLS.X('u') FROM T", "read", ["systools.*"])
        .verdict,
    ).toBe("slow");
    expect(
      quickPath("SELECT UPPER('u') FROM T", "read", ["SYSTOOLS.*"]).verdict,
    ).toBe("approve");
    expect(
      quickPath("SELECT QSYS2.QCMDEXC('X') FROM T", "read", []).verdict,
    ).toBe("approve");
  });
});

describe("evaluateParseStatementRows", () => {
  const evaluate = (
    rows: unknown[],
    access: "read" | "read-call" = "read",
    fns = QCMDEXC,
  ) => evaluateParseStatementRows(rows, access, fns);

  it("rejects zero rows as unverifiable", () => {
    expect(evaluate([])).toMatchObject({
      rule: "unverifiable",
      lowestMode: "write",
    });
  });

  it("allows a plain query in both modes", () => {
    const rows = [table, row("FUNCTION", null, "UPPER")];
    expect(evaluate(rows)).toBeUndefined();
    expect(evaluate(rows, "read-call")).toBeUndefined();
  });

  it("rejects disallowed statement types and names the lowest mode", () => {
    expect(
      evaluate([row("TABLE", "L", "T", "TARGET TABLE", "INSERT")]),
    ).toMatchObject({
      rule: "statement-type",
      offending: "INSERT",
      lowestMode: "write",
    });
    const call = [row("PROC", "QSYS2", "QCMDEXC", "TARGET PROCEDURE", "CALL")];
    expect(evaluate(call)).toMatchObject({
      rule: "statement-type",
      offending: "CALL",
      lowestMode: "read-call",
    });
    expect(evaluate(call, "read-call")).toBeUndefined();
    expect(
      evaluate([row("TABLE", "L", "T", "QUERY", "REFRESH TABLE")], "read-call"),
    ).toMatchObject({ rule: "statement-type" });
    expect(
      evaluate([{ NAME_TYPE: "TABLE", NAME: "T", USAGE_TYPE: "QUERY" }]),
    ).toMatchObject({ rule: "statement-type", offending: "UNKNOWN" });
  });

  it("rejects a data-change reference inside a QUERY in read and read-call", () => {
    // SELECT * FROM FINAL TABLE (INSERT INTO QTEMP.T ...)
    const rows = [row("TABLE", "QTEMP", "T", "TARGET TABLE")];
    for (const access of ["read", "read-call"] as const) {
      expect(evaluate(rows, access)).toMatchObject({
        rule: "write-usage",
        offending: "QTEMP.T",
        lowestMode: "write",
      });
    }
    expect(
      evaluate([row("COLUMN", null, "X", "DDL TARGET OBJECT")], "read-call"),
    ).toMatchObject({ rule: "write-usage" });
  });

  it("allows TARGET PROCEDURE only for the called procedure in read-call", () => {
    expect(
      evaluate(
        [row("PROC", "L", "P", "TARGET PROCEDURE", "QUERY")],
        "read-call",
      ),
    ).toMatchObject({ rule: "write-usage" });
    expect(
      evaluate(
        [row("TABLE", "L", "P", "TARGET PROCEDURE", "CALL")],
        "read-call",
      ),
    ).toMatchObject({ rule: "write-usage" });
  });

  it("rejects any sequence in read only (NEXT and PREVIOUS VALUE look alike)", () => {
    const rows = [row("SEQUENCE", "QGPL", "TOYSEQ")];
    expect(evaluate(rows)).toMatchObject({
      rule: "sequence",
      offending: "QGPL.TOYSEQ",
      lowestMode: "read-call",
    });
    expect(evaluate(rows, "read-call")).toBeUndefined();
  });

  it("matches forbidden functions by NAME or SCHEMA.NAME, case-insensitively", () => {
    const qualified = [row("FUNCTION", "QSYS2", "QCMDEXC")];
    expect(evaluate(qualified)).toMatchObject({
      rule: "forbidden-function",
      offending: "QSYS2.QCMDEXC",
      lowestMode: "read-call",
    });
    expect(evaluate(qualified, "read-call")).toBeUndefined();
    expect(evaluate([row("FUNCTION", null, "qcmdexc")])).toMatchObject({
      rule: "forbidden-function",
    });
    expect(
      evaluate([row("FUNCTION", "SYSTOOLS", "HTTPGETCLOB")], "read", [
        "systools.http*",
      ]),
    ).toMatchObject({ rule: "forbidden-function" });
    // Qualified patterns do not match unqualified references
    expect(
      evaluate([row("FUNCTION", null, "UPPER")], "read", ["SYSTOOLS.*"]),
    ).toBeUndefined();
    // Empty SCHEMA (as PARSE_STATEMENT reports for some forms) is unqualified
    expect(evaluate([row("FUNCTION", "", "QCMDEXC")])).toMatchObject({
      rule: "forbidden-function",
      offending: "QCMDEXC",
    });
    expect(evaluate(qualified, "read", [])).toBeUndefined();
  });
});

describe("parseStatementParams", () => {
  it("matches the connection's naming and decimal point", () => {
    expect(parseStatementParams("S", undefined)).toEqual([
      "S",
      "*SQL",
      "*PERIOD",
    ]);
    expect(
      parseStatementParams("S", { naming: "system", "decimal separator": "," }),
    ).toEqual(["S", "*SYS", "*COMMA"]);
  });
});

describe("stripStatementTerminator", () => {
  it("trims and removes trailing semicolons", () => {
    expect(stripStatementTerminator("  SELECT 1 FROM T;; \n")).toBe(
      "SELECT 1 FROM T",
    );
  });
});

describe("enforceExecuteSqlGuardrails", () => {
  const originalKeywords = config.ibmi_executeSqlForbiddenKeywords;
  afterEach(() => {
    config.ibmi_executeSqlForbiddenKeywords = originalKeywords;
  });

  const run = (
    sql: string,
    access: ExecuteSqlAccess,
    rows: unknown[] = [],
    extra: Partial<ExecuteSqlGuardrailOptions> = {},
  ) => {
    const parseStatement = vi
      .fn()
      .mockResolvedValue({ data: rows, is_done: true });
    const result = enforceExecuteSqlGuardrails(
      sql,
      { access, parseStatement, forbiddenFunctions: QCMDEXC, ...extra },
      context,
    );
    return { result, parseStatement };
  };

  const rejection = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(McpError);
    return error as McpError;
  };

  it("approves on the quick path without a round trip", async () => {
    const { result, parseStatement } = run("SELECT 1 FROM T", "read");
    await expect(result).resolves.toBe("quick");
    expect(parseStatement).not.toHaveBeenCalled();
  });

  it("asks PARSE_STATEMENT once with bound, connection-matched options", async () => {
    const { result, parseStatement } = run(
      "SELECT /* c */ 1 FROM QSYS2.SYSTABLES",
      "read",
      [table],
      { jdbcOptions: { naming: "system" } },
    );
    await expect(result).resolves.toBe("parse_statement");
    expect(parseStatement).toHaveBeenCalledTimes(1);
    const [query, params, rowsToFetch] = parseStatement.mock.calls[0]!;
    expect(rowsToFetch).toBe(10_000);
    expect(query).toContain("QSYS2.PARSE_STATEMENT");
    expect(query).toContain("SQL_STRING_DELIMITER => '*APOSTSQL'");
    expect(params).toEqual([
      "SELECT /* c */ 1 FROM QSYS2.SYSTABLES",
      "*SYS",
      "*PERIOD",
    ]);
  });

  it("rejects with mode, rule, offending name and lowest mode", async () => {
    const { result } = run(
      "SELECT * FROM FINAL TABLE (INSERT INTO QTEMP.T VALUES 1)",
      "read",
      [row("TABLE", "QTEMP", "T", "TARGET TABLE")],
    );
    const error = await rejection(result);
    expect(error.message).toContain("execute_sql read guardrail");
    expect(error.message).toContain("QTEMP.T");
    expect(error.message).toContain("The write guardrail mode allows it");
    expect(error.details).toMatchObject({
      access: "read",
      rule: "write-usage",
      offending: "QTEMP.T",
      lowestMode: "write",
      validatedBy: "parse_statement",
    });
  });

  it("rejects a quick-path CALL in read without a round trip", async () => {
    const { result, parseStatement } = run(
      "CALL QSYS2.GENERATE_SQL('T')",
      "read",
    );
    const error = await rejection(result);
    expect(error.details).toMatchObject({
      rule: "statement-type",
      lowestMode: "read-call",
      validatedBy: "quick",
    });
    expect(parseStatement).not.toHaveBeenCalled();
  });

  it("fails closed when PARSE_STATEMENT returns no rows", async () => {
    const empty = await rejection(
      run("SELECT 1 FROM T; DELETE FROM T", "read").result,
    );
    expect(empty.details).toMatchObject({ rule: "unverifiable" });
    expect(empty.message).toContain(
      "Only the write guardrail mode skips this check",
    );
  });

  it("rethrows a PARSE_STATEMENT execution failure unchanged", async () => {
    const lost = new Error("connection lost");
    const parseStatement = vi.fn().mockRejectedValue(lost);
    await expect(
      enforceExecuteSqlGuardrails(
        "SELECT /* c */ 1 FROM T",
        { access: "read-call", parseStatement },
        context,
      ),
    ).rejects.toBe(lost);
  });

  it("judges every PARSE_STATEMENT row, and rejects an incomplete result", async () => {
    // The write row comes after more than 100 QUERY rows (the default fetch)
    const many = [
      ...Array.from({ length: 150 }, () => row("COLUMN", null, "A")),
      row("TABLE", "QTEMP", "X", "TARGET TABLE"),
    ];
    const late = await rejection(
      run("SELECT /* c */ A FROM FINAL TABLE (INSERT ...)", "read", many)
        .result,
    );
    expect(late.details).toMatchObject({ rule: "write-usage" });

    const parseStatement = vi
      .fn()
      .mockResolvedValue({ data: [table], is_done: false });
    const partial = await rejection(
      enforceExecuteSqlGuardrails(
        "SELECT /* c */ 1 FROM QSYS2.SYSTABLES",
        { access: "read", parseStatement },
        context,
      ),
    );
    expect(partial.details).toMatchObject({ rule: "unverifiable" });
  });

  it("write never calls PARSE_STATEMENT", async () => {
    const { result, parseStatement } = run("DELETE FROM T", "write");
    await expect(result).resolves.toBe("write");
    expect(parseStatement).not.toHaveBeenCalled();
  });

  it("applies forbidden keywords in every mode, outside strings and comments", async () => {
    for (const access of ["read", "read-call", "write"] as const) {
      const { result } = run("SELECT * FROM PAYROLL.SALARY", access, [], {
        forbiddenKeywords: ["payroll.*"],
      });
      const error = await rejection(result);
      expect(error.details).toMatchObject({
        rule: "forbidden-keyword",
        offending: "PAYROLL.SALARY",
        lowestMode: null,
      });
      expect(error.message).toContain("every guardrail mode");
    }
    await expect(
      run("SELECT 'DROP' FROM T -- DROP", "write", [], {
        forbiddenKeywords: ["DROP"],
      }).result,
    ).resolves.toBe("write");
    await expect(
      run("DROP TABLE T", "write", [], { forbiddenKeywords: ["dr*"] }).result,
    ).rejects.toThrow(/"DROP" matches forbidden keyword pattern "dr\*"/);
  });

  it.each([
    ["UPDATE", `UPDATE"MYLIB"."T" SET A = 1`],
    ["TRUNCATE", `TRUNCATE"MYLIB"."T"`],
    ["CALL", `CALL"QSYS2"."QCMDEXC"('DSPLIB QGPL')`],
    ["DROP", `ALTER TABLE MYLIB."T"DROP COLUMN C`],
    ["LIKE", "SELECT * FROM T WHERE A LIKE'x%'"],
    ["SALARY", "SELECT * FROM T WHERE SALARY!=0"],
    ["QSYS2.SYSCOLUMNS", "SELECT * FROM QSYS2\n.SYSCOLUMNS"],
    ["QSYS2.SYSCOLUMNS", "SELECT * FROM QSYS2. -- c\n SYSCOLUMNS"],
  ])("forbidden keyword %s is not dodged by: %s", async (pattern, sql) => {
    await expect(
      run(sql, "write", [], { forbiddenKeywords: [pattern] }).result,
    ).rejects.toThrow(/forbidden keyword/);
  });

  it("adds IBMI_EXECUTE_SQL_FORBIDDEN_KEYWORDS to the per-call list", async () => {
    config.ibmi_executeSqlForbiddenKeywords = ["QSECOFR"];
    await expect(
      run("SELECT * FROM T WHERE U = QSECOFR", "write").result,
    ).rejects.toThrow(/QSECOFR/);
  });

  it("enforces the length limit first", async () => {
    const error = await rejection(
      run("SELECT 1 FROM T", "write", [], { maxQueryLength: 5 }).result,
    );
    expect(error.details).toMatchObject({ rule: "max-length" });
  });
});
