import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { expandEnvVars } from "../../src/config/credentials";

describe("expandEnvVars", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env["TEST_HOST"] = "myhost.example.com";
    process.env["TEST_USER"] = "TESTUSER";
    process.env["TEST_PASS"] = "secret123";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should expand a single env var", () => {
    expect(expandEnvVars("${TEST_HOST}")).toBe("myhost.example.com");
  });

  it("should expand multiple env vars", () => {
    expect(expandEnvVars("${TEST_USER}@${TEST_HOST}")).toBe(
      "TESTUSER@myhost.example.com",
    );
  });

  it("should leave unset vars unexpanded", () => {
    expect(expandEnvVars("${NONEXISTENT_VAR}")).toBe("${NONEXISTENT_VAR}");
  });

  it("should return plain strings unchanged", () => {
    expect(expandEnvVars("plain-value")).toBe("plain-value");
  });

  it("should handle empty env var value", () => {
    process.env["EMPTY_VAR"] = "";
    expect(expandEnvVars("${EMPTY_VAR}")).toBe("");
  });

  it("should handle mixed text and vars", () => {
    expect(expandEnvVars("host=${TEST_HOST}:8076")).toBe(
      "host=myhost.example.com:8076",
    );
  });
});
