import { describe, it, expect } from "vitest";
import { createProgram } from "../../src/index";

describe("ibmi columns command", () => {
  it("should register the columns command with correct description", () => {
    const program = createProgram();
    const columns = program.commands.find((c) => c.name() === "columns");
    expect(columns).toBeDefined();
    expect(columns?.description()).toBe("Get column metadata for a table");
  });

  it("should have 2 required arguments: schema and table", () => {
    const program = createProgram();
    const columns = program.commands.find((c) => c.name() === "columns");
    const args = columns?.registeredArguments;
    expect(args).toHaveLength(2);
    expect(args?.[0]?.name()).toBe("schema");
    expect(args?.[0]?.required).toBe(true);
    expect(args?.[1]?.name()).toBe("table");
    expect(args?.[1]?.required).toBe(true);
  });

  it("should have command name 'columns'", () => {
    const program = createProgram();
    const columns = program.commands.find((c) => c.name() === "columns");
    expect(columns?.name()).toBe("columns");
  });
});
