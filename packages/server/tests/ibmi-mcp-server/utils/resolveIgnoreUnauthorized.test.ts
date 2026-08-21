/**
 * @fileoverview Tests for ignore-unauthorized resolution precedence.
 * @module tests/ibmi-mcp-server/utils/resolveIgnoreUnauthorized.test
 */
import { describe, it, expect } from "vitest";
import { resolveIgnoreUnauthorized } from "../../../src/ibmi-mcp-server/utils/resolveIgnoreUnauthorized.js";

describe("resolveIgnoreUnauthorized", () => {
  it("defaults to false when YAML and env are both absent", () => {
    expect(resolveIgnoreUnauthorized(undefined, undefined)).toBe(false);
    expect(resolveIgnoreUnauthorized(undefined, "")).toBe(false);
    expect(resolveIgnoreUnauthorized(undefined, "   ")).toBe(false);
  });

  it("uses env when YAML omits the key", () => {
    expect(resolveIgnoreUnauthorized(undefined, "true")).toBe(true);
    expect(resolveIgnoreUnauthorized(undefined, "1")).toBe(true);
    expect(resolveIgnoreUnauthorized(undefined, "false")).toBe(false);
    expect(resolveIgnoreUnauthorized(undefined, "0")).toBe(false);
    expect(resolveIgnoreUnauthorized(undefined, "yes")).toBe(false);
  });

  it("uses explicit YAML true", () => {
    expect(resolveIgnoreUnauthorized(true, undefined)).toBe(true);
    expect(resolveIgnoreUnauthorized(true, "false")).toBe(true);
  });

  it("lets YAML false win over env true", () => {
    expect(resolveIgnoreUnauthorized(false, "true")).toBe(false);
    expect(resolveIgnoreUnauthorized(false, "1")).toBe(false);
  });
});
