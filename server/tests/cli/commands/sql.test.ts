import { describe, it, expect, vi, afterEach } from "vitest";
import { createProgram } from "../../../src/cli/index";

describe("ibmi sql command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
