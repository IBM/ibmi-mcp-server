import { describe, it, expect, afterEach } from "vitest";
import { createProgram } from "../../src/program";

describe("--watch global option", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("should register --watch as a global option", () => {
    const program = createProgram();
    const watchOpt = program.options.find((o) => o.long === "--watch");
    expect(watchOpt).toBeDefined();
    expect(watchOpt?.flags).toContain("<seconds>");
  });

  it("should parse watch interval from arguments", () => {
    const program = createProgram();
    program.parseOptions(["--watch", "5"]);
    expect(program.opts()["watch"]).toBe("5");
  });

  it("should reject an unusable --watch value as a usage error (exit 2)", async () => {
    const stderrWrites: string[] = [];
    const originalStderr = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrWrites.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      for (const value of ["abc", "0"]) {
        process.exitCode = undefined;
        const program = createProgram();
        program.exitOverride();
        await program.parseAsync([
          "node", "ibmi", "--format", "table", "--watch", value, "schemas",
        ]);
        expect(process.exitCode).toBe(2);
      }
      expect(stderrWrites.join("")).toContain('Invalid --watch value: "abc"');
      expect(stderrWrites.join("")).toContain('Invalid --watch value: "0"');
    } finally {
      process.stderr.write = originalStderr;
    }
  });
});
