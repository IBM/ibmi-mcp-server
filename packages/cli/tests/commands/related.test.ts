import { describe, it, expect } from "vitest";
import { createProgram } from "../../src/index";

describe("ibmi related command", () => {
  it("should register the related command with correct description", () => {
    const program = createProgram();
    const related = program.commands.find((c) => c.name() === "related");
    expect(related).toBeDefined();
    expect(related?.description()).toBe(
      "Find objects that depend on a database file",
    );
  });

  it("should have 2 required arguments: library and object", () => {
    const program = createProgram();
    const related = program.commands.find((c) => c.name() === "related");
    const args = related?.registeredArguments;
    expect(args).toHaveLength(2);
    expect(args?.[0]?.name()).toBe("library");
    expect(args?.[0]?.required).toBe(true);
    expect(args?.[1]?.name()).toBe("object");
    expect(args?.[1]?.required).toBe(true);
  });

  it("should have --type option for filtering by object type", () => {
    const program = createProgram();
    const related = program.commands.find((c) => c.name() === "related");
    const typeOpt = related?.options.find((o) => o.long === "--type");
    expect(typeOpt).toBeDefined();
  });
});
