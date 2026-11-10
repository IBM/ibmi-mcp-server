/**
 * @fileoverview Tests for the idGenerator utility.
 * @module tests/utils/security/idGenerator.test
 */
import { describe, it, expect } from "vitest";
import { generateShortAlphanumericId } from "../../../src/utils/security/idGenerator";

describe("generateShortAlphanumericId", () => {
  it("should generate an 8-character alphanumeric string", () => {
    const shortId = generateShortAlphanumericId();
    const shortIdRegex = /^[A-Z0-9]{8}$/;
    expect(shortId).toHaveLength(8);
    expect(shortId).toMatch(shortIdRegex);
  });
});
