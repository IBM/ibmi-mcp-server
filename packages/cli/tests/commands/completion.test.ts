import { describe, it, expect } from "vitest";
import { createProgram } from "../../src/index";

describe("ibmi completion command", () => {
  it("should register the completion command", () => {
    const program = createProgram();
    const completion = program.commands.find((c) => c.name() === "completion");
    expect(completion).toBeDefined();
    expect(completion?.description()).toContain("shell completion");
  });

  it("should output bash completion script", async () => {
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
      expect(output).toContain("_ibmi_completions");
      expect(output).toContain("complete -F");
      expect(output).toContain("system");
      expect(output).toContain("schemas");
      expect(output).toContain("--format");
    } finally {
      process.stdout.write = original;
    }
  });

  it("should output zsh completion script", async () => {
    const writes: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "completion", "zsh"]);
      const output = writes.join("");
      expect(output).toContain("#compdef ibmi");
      expect(output).toContain("_ibmi");
    } finally {
      process.stdout.write = original;
    }
  });

  it("should output fish completion script", async () => {
    const writes: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(["node", "ibmi", "completion", "fish"]);
      const output = writes.join("");
      expect(output).toContain("complete -c ibmi");
    } finally {
      process.stdout.write = original;
    }
  });

  it("should error on unknown shell", async () => {
    const stderrWrites: string[] = [];
    const original = process.stderr.write;
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
        "completion",
        "powershell",
      ]);
      expect(stderrWrites.join("")).toContain("Unknown shell");
    } finally {
      process.stderr.write = original;
    }
  });
});
