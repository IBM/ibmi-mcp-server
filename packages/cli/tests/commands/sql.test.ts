import { describe, it, expect, vi, afterEach } from "vitest";
import { createProgram } from "../../src/index";
import { writeFileSync, unlinkSync } from "fs";
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
    expect(
      sql?.options.find((o) => o.long === "--file"),
    ).toBeDefined();
  });

  it("should have --dry-run option", () => {
    const program = createProgram();
    const sql = program.commands.find((c) => c.name() === "sql");
    expect(
      sql?.options.find((o) => o.long === "--dry-run"),
    ).toBeDefined();
  });

  it("should have --read-only and --no-read-only options", () => {
    const program = createProgram();
    const sql = program.commands.find((c) => c.name() === "sql");
    expect(
      sql?.options.find((o) => o.long === "--read-only"),
    ).toBeDefined();
    expect(
      sql?.options.find((o) => o.long === "--no-read-only"),
    ).toBeDefined();
  });

  it("should have --limit option", () => {
    const program = createProgram();
    const sql = program.commands.find((c) => c.name() === "sql");
    expect(
      sql?.options.find((o) => o.long === "--limit"),
    ).toBeDefined();
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
      await program.parseAsync(
        ["node", "ibmi", "sql", "SELECT 1 FROM SYSIBM.SYSDUMMY1", "--dry-run"],
      );

      const output = writes.join("");
      expect(output).toContain("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("should write 'No SQL provided' to stderr when no SQL given", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

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
        "node", "ibmi", "sql", "--file", tmpFile, "--dry-run",
      ]);

      expect(stdoutWrites.join("")).toContain("SELECT * FROM MYLIB.MYTABLE");
    } finally {
      process.stdout.write = originalWrite;
      try { unlinkSync(tmpFile); } catch { /* cleanup */ }
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
        "node", "ibmi", "sql", "--file", "/tmp/nonexistent-ibmi-test-file.sql",
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
        "node", "ibmi", "sql", "--file", tmpFile, "--dry-run",
      ]);

      expect(stdoutWrites.join("")).toContain("SELECT COUNT(*) FROM QSYS2.SYSTABLES");
      expect(stderrWrites.join("")).not.toContain("connect");
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
      try { unlinkSync(tmpFile); } catch { /* cleanup */ }
    }
  });
});
