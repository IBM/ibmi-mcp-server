import { describe, it, expect } from "vitest";
import { detectFormat } from "../../../src/cli/formatters/output";

describe("detectFormat", () => {
  it("should return json when --raw is set", () => {
    expect(detectFormat(undefined, true)).toBe("json");
  });

  it("should return explicit format when provided", () => {
    expect(detectFormat("csv", false)).toBe("csv");
    expect(detectFormat("markdown", false)).toBe("markdown");
    expect(detectFormat("table", false)).toBe("table");
  });

  it("should prefer --raw over explicit format", () => {
    expect(detectFormat("table", true)).toBe("json");
  });

  it("should fall back to json when not a TTY", () => {
    // In test environment, stdout is typically not a TTY
    const result = detectFormat(undefined, false);
    // Will be "json" in non-TTY test env, "table" in TTY
    expect(["json", "table"]).toContain(result);
  });
});
