import { describe, it, expect } from "vitest";
import { createProgram } from "../../src/index";

describe("ibmi validate command", () => {
  it("should register the validate command with correct description", () => {
    const program = createProgram();
    const validate = program.commands.find((c) => c.name() === "validate");
    expect(validate).toBeDefined();
    expect(validate?.description()).toBe(
      "Validate SQL syntax and verify referenced objects exist",
    );
  });

  it("should have 1 required argument: sql", () => {
    const program = createProgram();
    const validate = program.commands.find((c) => c.name() === "validate");
    const args = validate?.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args?.[0]?.name()).toBe("sql");
    expect(args?.[0]?.required).toBe(true);
  });

  it("should have command name 'validate'", () => {
    const program = createProgram();
    const validate = program.commands.find((c) => c.name() === "validate");
    expect(validate?.name()).toBe("validate");
  });
});
