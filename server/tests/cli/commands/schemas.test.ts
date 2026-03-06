import { describe, it, expect, vi, afterEach } from "vitest";
import { createProgram } from "../../../src/cli/index";

describe("ibmi schemas command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should register the schemas command", () => {
    const program = createProgram();
    const schemas = program.commands.find((c) => c.name() === "schemas");
    expect(schemas).toBeDefined();
    expect(schemas?.description()).toBe(
      "List schemas/libraries on the target system",
    );
  });

  it("should have --filter option", () => {
    const program = createProgram();
    const schemas = program.commands.find((c) => c.name() === "schemas");
    const filterOpt = schemas?.options.find(
      (o) => o.long === "--filter",
    );
    expect(filterOpt).toBeDefined();
  });

  it("should have --system-schemas option", () => {
    const program = createProgram();
    const schemas = program.commands.find((c) => c.name() === "schemas");
    const sysOpt = schemas?.options.find(
      (o) => o.long === "--system-schemas",
    );
    expect(sysOpt).toBeDefined();
  });

  it("should have --limit and --offset options", () => {
    const program = createProgram();
    const schemas = program.commands.find((c) => c.name() === "schemas");
    expect(
      schemas?.options.find((o) => o.long === "--limit"),
    ).toBeDefined();
    expect(
      schemas?.options.find((o) => o.long === "--offset"),
    ).toBeDefined();
  });
});
