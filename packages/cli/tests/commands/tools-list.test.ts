import { describe, it, expect } from "vitest";
import { createProgram } from "../../src/index";

describe("ibmi tools command", () => {
  it("should register the tools command", () => {
    const program = createProgram();
    const tools = program.commands.find((c) => c.name() === "tools");
    expect(tools).toBeDefined();
    expect(tools?.description()).toBe("List available YAML-defined tools");
  });

  it("should have --toolset option", () => {
    const program = createProgram();
    const tools = program.commands.find((c) => c.name() === "tools");
    expect(
      tools?.options.find((o) => o.long === "--toolset"),
    ).toBeDefined();
  });

  it("should have a show subcommand", () => {
    const program = createProgram();
    const tools = program.commands.find((c) => c.name() === "tools");
    const show = tools?.commands.find((c) => c.name() === "show");
    expect(show).toBeDefined();
    expect(show?.description()).toBe("Show detailed information for a tool");
  });
});

describe("ibmi toolsets command", () => {
  it("should register the toolsets command", () => {
    const program = createProgram();
    const toolsets = program.commands.find((c) => c.name() === "toolsets");
    expect(toolsets).toBeDefined();
    expect(toolsets?.description()).toBe("List available toolsets");
  });
});
