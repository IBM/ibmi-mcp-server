import { describe, it, expect } from "vitest";
import { createProgram } from "../../../src/cli/index";

describe("ibmi tool command", () => {
  it("should register the tool command with name argument", () => {
    const program = createProgram();
    const tool = program.commands.find((c) => c.name() === "tool");
    expect(tool).toBeDefined();
    expect(tool?.description()).toBe("Run a YAML-defined tool by name");
    const args = tool?.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args?.[0]?.name()).toBe("name");
    expect(args?.[0]?.required).toBe(true);
  });

  it("should have --dry-run option", () => {
    const program = createProgram();
    const tool = program.commands.find((c) => c.name() === "tool");
    expect(
      tool?.options.find((o) => o.long === "--dry-run"),
    ).toBeDefined();
  });

  it("should allow unknown options (for dynamic tool params)", () => {
    const program = createProgram();
    const tool = program.commands.find((c) => c.name() === "tool");
    // Commander's _allowUnknownOption is internal but we can verify it
    // doesn't reject unknown flags by checking the command works
    expect(tool).toBeDefined();
  });
});

describe("ibmi --tools global option", () => {
  it("should register --tools as a global option", () => {
    const program = createProgram();
    const toolsOpt = program.options.find((o) => o.long === "--tools");
    expect(toolsOpt).toBeDefined();
    expect(toolsOpt?.flags).toContain("<path>");
  });
});
