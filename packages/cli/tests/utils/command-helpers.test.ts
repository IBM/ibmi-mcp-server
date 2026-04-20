import { describe, it, expect } from "vitest";
import { createCliContext } from "../../src/utils/command-helpers";

describe("createCliContext", () => {
  it("should return a context with requestId and timestamp", () => {
    const ctx = createCliContext("test_tool");
    expect(ctx.requestId).toMatch(/^cli-/);
    expect(ctx.timestamp).toBeTruthy();
    expect(ctx["toolName"]).toBe("test_tool");
    expect(ctx["operation"]).toBe("CliToolExecution");
  });

  it("should generate unique requestIds", () => {
    const ctx1 = createCliContext("tool1");
    const ctx2 = createCliContext("tool2");
    expect(ctx1.requestId).not.toBe(ctx2.requestId);
  });

  it("should include ISO timestamp", () => {
    const ctx = createCliContext("test_tool");
    // Verify it's a valid ISO date string
    expect(() => new Date(ctx.timestamp as string)).not.toThrow();
    expect(new Date(ctx.timestamp as string).toISOString()).toBe(ctx.timestamp);
  });
});
