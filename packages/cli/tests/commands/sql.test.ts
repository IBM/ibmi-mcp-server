import { describe, it, expect, vi, afterEach } from "vitest";
import { createProgram } from "../../src/program.js";
import { applyRowLimit, limitRows } from "../../src/commands/sql.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

describe("ibmi sql command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("should register the sql command", () => {
    const program = createProgram();
    const sql = program.commands.find((c) => c.name() === "sql");
    expect(sql).toBeDefined();
    expect(sql?.description()).toBe(
      "Execute a SQL query against the target system",
    );
  });

  it("should have --file option", () => {
    const program = createProgram();
    const sql = program.commands.find((c) => c.name() === "sql");
    expect(sql?.options.find((o) => o.long === "--file")).toBeDefined();
  });

  it("should have --dry-run option", () => {
    const program = createProgram();
    const sql = program.commands.find((c) => c.name() === "sql");
    expect(sql?.options.find((o) => o.long === "--dry-run")).toBeDefined();
  });

  it("should have --read-only and --no-read-only options", () => {
    const program = createProgram();
    const sql = program.commands.find((c) => c.name() === "sql");
    expect(sql?.options.find((o) => o.long === "--read-only")).toBeDefined();
    expect(sql?.options.find((o) => o.long === "--no-read-only")).toBeDefined();
  });

  it("should have --limit option", () => {
    const program = createProgram();
    const sql = program.commands.find((c) => c.name() === "sql");
    expect(sql?.options.find((o) => o.long === "--limit")).toBeDefined();
  });

  it("should output SQL with --dry-run", async () => {
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "sql",
        "SELECT 1 FROM SYSIBM.SYSDUMMY1",
        "--dry-run",
      ]);

      const output = writes.join("");
      expect(output).toContain("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("should write 'No SQL provided' to stderr when no SQL given", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    const stderrWrites: string[] = [];
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrWrites.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "sql"]);

      expect(stderrWrites.join("")).toContain("No SQL provided");
    } finally {
      process.stderr.write = originalStderrWrite;
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  it("should read SQL from --file and print it with --dry-run", async () => {
    const tmpFile = path.join(os.tmpdir(), `ibmi-sql-test-${Date.now()}.sql`);
    writeFileSync(tmpFile, "SELECT * FROM MYLIB.MYTABLE", "utf-8");

    const stdoutWrites: string[] = [];
    const originalWrite = process.stdout.write;
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
        "sql",
        "--file",
        tmpFile,
        "--dry-run",
      ]);

      expect(stdoutWrites.join("")).toContain("SELECT * FROM MYLIB.MYTABLE");
    } finally {
      process.stdout.write = originalWrite;
      try {
        unlinkSync(tmpFile);
      } catch {
        /* cleanup */
      }
    }
  });

  it("should write 'Error reading file' to stderr for non-existent --file", async () => {
    const stderrWrites: string[] = [];
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrWrites.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "sql",
        "--file",
        "/tmp/nonexistent-ibmi-test-file.sql",
      ]);

      expect(stderrWrites.join("")).toContain("Error reading file");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  it("should not attempt connection when using --dry-run with --file", async () => {
    const tmpFile = path.join(os.tmpdir(), `ibmi-sql-dryrun-${Date.now()}.sql`);
    writeFileSync(tmpFile, "SELECT COUNT(*) FROM QSYS2.SYSTABLES", "utf-8");

    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const originalStdout = process.stdout.write;
    const originalStderr = process.stderr.write;

    process.stdout.write = ((chunk: string) => {
      stdoutWrites.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrWrites.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "sql",
        "--file",
        tmpFile,
        "--dry-run",
      ]);

      expect(stdoutWrites.join("")).toContain(
        "SELECT COUNT(*) FROM QSYS2.SYSTABLES",
      );
      expect(stderrWrites.join("")).not.toContain("connect");
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
      try {
        unlinkSync(tmpFile);
      } catch {
        /* cleanup */
      }
    }
  });

  it("should write --dry-run output to the --output file", async () => {
    const outputFile = path.join(
      os.tmpdir(),
      `ibmi-sql-dryrun-${Date.now()}.txt`,
    );
    const stdoutWrites: string[] = [];
    const originalStdout = process.stdout.write;
    const originalStderr = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutWrites.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

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
        "sql",
        "SELECT 1 FROM SYSIBM.SYSDUMMY1",
        "--dry-run",
      ]);

      expect(stdoutWrites.join("")).toBe("");
      expect(readFileSync(outputFile, "utf-8")).toBe(
        "SELECT 1 FROM SYSIBM.SYSDUMMY1\n",
      );
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
      if (existsSync(outputFile)) unlinkSync(outputFile);
    }
  });

  it("should reject an invalid --limit as a usage error (exit 2)", async () => {
    const stderrWrites: string[] = [];
    const originalStderr = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrWrites.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node",
        "ibmi",
        "--format",
        "table",
        "sql",
        "SELECT 1 FROM SYSIBM.SYSDUMMY1",
        "--limit",
        "abc",
      ]);

      expect(stderrWrites.join("")).toContain('Invalid --limit value: "abc"');
      expect(process.exitCode).toBe(2);
    } finally {
      process.stderr.write = originalStderr;
    }
  });

  describe("applyRowLimit", () => {
    it("appends FETCH FIRST limit+1 to SELECT statements", () => {
      // The extra row lets limitRows report that the limit cut the result.
      expect(applyRowLimit("SELECT * FROM QSYS2.SYSTABLES;", 10)).toBe(
        "SELECT * FROM QSYS2.SYSTABLES FETCH FIRST 11 ROWS ONLY",
      );
    });

    it("appends FETCH FIRST to WITH and VALUES statements", () => {
      expect(
        applyRowLimit(
          "WITH t AS (SELECT 1 FROM SYSIBM.SYSDUMMY1) SELECT * FROM t",
          5,
        ),
      ).toMatch(/ FETCH FIRST 6 ROWS ONLY$/);
      expect(applyRowLimit("VALUES 1", 5)).toBe(
        "VALUES 1 FETCH FIRST 6 ROWS ONLY",
      );
    });

    it("leaves non-query statements unchanged (#173)", () => {
      const call = "CALL QSYS2.QCMDEXC('DSPLIBL')";
      expect(applyRowLimit(call, 10)).toBe(call);
      const insert = "INSERT INTO MYLIB.T VALUES (1)";
      expect(applyRowLimit(insert, 10)).toBe(insert);
      const ddl = "CREATE TABLE QTEMP.T (C INT)";
      expect(applyRowLimit(ddl, 10)).toBe(ddl);
    });

    it("does not add a second fetch clause", () => {
      const sql = "SELECT 1 FROM SYSIBM.SYSDUMMY1 FETCH FIRST 1 ROWS ONLY";
      expect(applyRowLimit(sql, 10)).toBe(sql);
    });

    it("is a no-op when no limit is set", () => {
      expect(applyRowLimit("SELECT 1 FROM SYSIBM.SYSDUMMY1", undefined)).toBe(
        "SELECT 1 FROM SYSIBM.SYSDUMMY1",
      );
    });

    it("leaves statements alone when appending would produce invalid or ineffective SQL", () => {
      for (const sql of [
        // already limited
        "SELECT * FROM T LIMIT 10",
        "SELECT * FROM T ORDER BY A OFFSET 20 ROWS",
        "SELECT * FROM T FETCH  NEXT 5 ROWS ONLY",
        // the clause would land inside the comment
        "SELECT * FROM T -- newest first",
        "SELECT * FROM T /* newest first */",
        // clauses that must follow FETCH FIRST
        "SELECT * FROM T FOR READ ONLY",
        "SELECT * FROM T FOR FETCH ONLY",
        "SELECT * FROM T FOR UPDATE OF A",
        "SELECT * FROM T OPTIMIZE FOR 10 ROWS",
        "SELECT * FROM T WITH UR",
        "select * from t with nc",
        "SELECT * FROM T SKIP LOCKED DATA",
      ]) {
        expect(applyRowLimit(sql, 5000)).toBe(sql);
      }
    });

    it("still limits a statement whose identifiers merely contain those words", () => {
      expect(applyRowLimit("SELECT CREDIT_LIMIT, FORMAT FROM T", 5)).toBe(
        "SELECT CREDIT_LIMIT, FORMAT FROM T FETCH FIRST 6 ROWS ONLY",
      );
    });
  });

  describe("limitRows", () => {
    const rows = [{ A: 1 }, { A: 2 }, { A: 3 }];

    it("drops rows beyond the limit and reports it", () => {
      expect(limitRows(rows, 2)).toEqual({
        rows: [{ A: 1 }, { A: 2 }],
        limited: true,
      });
    });

    it("returns the rows untouched when within the limit or unlimited", () => {
      expect(limitRows(rows, 3)).toEqual({ rows, limited: false });
      expect(limitRows(rows, undefined)).toEqual({ rows, limited: false });
    });
  });
});
