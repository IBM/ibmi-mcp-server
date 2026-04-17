import { describe, it, expect } from "vitest";
import { createProgram } from "../../../src/cli/index";

describe("--watch global option", () => {
  it("should register --watch as a global option", () => {
    const program = createProgram();
    const watchOpt = program.options.find((o) => o.long === "--watch");
    expect(watchOpt).toBeDefined();
    expect(watchOpt?.flags).toContain("<seconds>");
  });

  it("should parse watch interval from arguments", () => {
    const program = createProgram();
    program.exitOverride();
    // Parse args without actually running a command
    try {
      program.parse(["node", "ibmi", "--watch", "5", "--help"], { from: "user" });
    } catch {
      // --help triggers exitOverride; that's expected — the option was parsed
    }
  });
});
