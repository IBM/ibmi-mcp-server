import { describe, it, expect, vi, afterEach } from "vitest";
import { createProgram } from "../../../src/cli/index";

describe("ibmi describe command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("should register the describe command with correct description", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "describe");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toBe(
      "Generate DDL for one or more SQL objects (comma-separated LIBRARY.OBJECT)",
    );
  });

  it("should have --type option with default TABLE", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "describe");
    const typeOpt = cmd?.options.find((o) => o.long === "--type");
    expect(typeOpt).toBeDefined();
    expect(typeOpt?.defaultValue).toBe("TABLE");
  });

  it("should have 1 required argument: objects", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "describe");
    const args = cmd?.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args?.[0]?.name()).toBe("objects");
    expect(args?.[0]?.required).toBe(true);
  });

  it("should write invalid type error to stderr for bad --type", async () => {
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
        "describe",
        "MYLIB.MYTABLE",
        "--type",
        "BOGUS",
      ]);

      expect(stderrWrites.join("")).toContain("Invalid --type");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  it("should be included in the completion COMMANDS array", async () => {
    const writes: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "completion", "bash"]);
      const output = writes.join("");
      expect(output).toContain("describe");
    } finally {
      process.stdout.write = original;
    }
  });
});
