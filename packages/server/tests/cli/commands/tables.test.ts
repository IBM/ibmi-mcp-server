import { describe, it, expect } from "vitest";
import { createProgram } from "../../../src/cli/index";

describe("ibmi tables command", () => {
  it("should register the tables command with schema argument", () => {
    const program = createProgram();
    const tables = program.commands.find((c) => c.name() === "tables");
    expect(tables).toBeDefined();
    expect(tables?.description()).toBe(
      "List tables, views, and physical files in a schema",
    );
    // Commander stores arguments in registeredArguments
    const args = tables?.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args?.[0]?.name()).toBe("schema");
    expect(args?.[0]?.required).toBe(true);
  });

  it("should have --filter option", () => {
    const program = createProgram();
    const tables = program.commands.find((c) => c.name() === "tables");
    expect(
      tables?.options.find((o) => o.long === "--filter"),
    ).toBeDefined();
  });
});
