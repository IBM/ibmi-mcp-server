import { describe, it, expect, afterEach } from "vitest";
import { resolveSystem, resolveSystems } from "../../src/config/resolver";
import type { CliConfig } from "../../src/config/types";

const originalEnv = { ...process.env };

const testConfig: CliConfig = {
  default: "dev",
  systems: {
    dev: {
      host: "dev400.com",
      port: 8076,
      user: "DEV",
      readOnly: false,
      confirm: false,
      timeout: 60,
      maxRows: 5000,
      ignoreUnauthorized: true,
    },
    prod: {
      host: "prod400.com",
      port: 8076,
      user: "PROD",
      readOnly: true,
      confirm: true,
      timeout: 30,
      maxRows: 1000,
      ignoreUnauthorized: true,
    },
  },
};

describe("resolveSystem", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should resolve from --system flag (highest priority)", () => {
    process.env["IBMI_SYSTEM"] = "dev"; // Should be overridden
    const result = resolveSystem("prod", testConfig);
    expect(result.name).toBe("prod");
    expect(result.source).toBe("flag");
    expect(result.config.host).toBe("prod400.com");
  });

  it("should resolve from IBMI_SYSTEM env var", () => {
    process.env["IBMI_SYSTEM"] = "prod";
    const result = resolveSystem(undefined, testConfig);
    expect(result.name).toBe("prod");
    expect(result.source).toBe("env");
  });

  it("should resolve from config default", () => {
    delete process.env["IBMI_SYSTEM"];
    const result = resolveSystem(undefined, testConfig);
    expect(result.name).toBe("dev");
    expect(result.source).toBe("config-default");
  });

  it("should resolve single system without default", () => {
    delete process.env["IBMI_SYSTEM"];
    const singleConfig: CliConfig = {
      systems: {
        only: {
          host: "only400.com",
          port: 8076,
          user: "ONLY",
          readOnly: false,
          confirm: false,
          timeout: 60,
          maxRows: 5000,
          ignoreUnauthorized: true,
        },
      },
    };
    const result = resolveSystem(undefined, singleConfig);
    expect(result.name).toBe("only");
    expect(result.source).toBe("config-default");
  });

  it("should fall back to legacy DB2i_* env vars", () => {
    delete process.env["IBMI_SYSTEM"];
    process.env["DB2i_HOST"] = "legacy400.com";
    process.env["DB2i_USER"] = "LEGACY";
    process.env["DB2i_PASS"] = "pass";

    const emptyConfig: CliConfig = { systems: {} };
    const result = resolveSystem(undefined, emptyConfig);
    expect(result.name).toBe("env");
    expect(result.source).toBe("legacy-env");
    expect(result.config.host).toBe("legacy400.com");
  });

  it("should throw for unknown --system flag value", () => {
    expect(() => resolveSystem("nonexistent", testConfig)).toThrow(
      /not found/,
    );
  });

  it("should throw for unknown IBMI_SYSTEM env value", () => {
    process.env["IBMI_SYSTEM"] = "nonexistent";
    expect(() => resolveSystem(undefined, testConfig)).toThrow(/not found/);
  });

  it("should throw when no system can be resolved", () => {
    delete process.env["IBMI_SYSTEM"];
    delete process.env["DB2i_HOST"];
    delete process.env["DB2i_USER"];
    const emptyConfig: CliConfig = { systems: {} };
    expect(() => resolveSystem(undefined, emptyConfig)).toThrow(
      /No IBM i system configured/,
    );
  });
});

describe("resolveSystems", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should return single-element array for non-comma flag", () => {
    const result = resolveSystems("dev", testConfig);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("dev");
    expect(result[0].config.host).toBe("dev400.com");
  });

  it("should return multiple systems for comma-separated flag", () => {
    const result = resolveSystems("dev,prod", testConfig);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("dev");
    expect(result[0].config.host).toBe("dev400.com");
    expect(result[1].name).toBe("prod");
    expect(result[1].config.host).toBe("prod400.com");
  });

  it("should trim whitespace in system names", () => {
    const result = resolveSystems("dev , prod", testConfig);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("dev");
    expect(result[1].name).toBe("prod");
  });

  it("should throw if any system in the list is not found", () => {
    expect(() => resolveSystems("dev,nonexistent", testConfig)).toThrow(
      /not found/,
    );
  });

  it("should delegate to resolveSystem for single-system case", () => {
    delete process.env["IBMI_SYSTEM"];
    const result = resolveSystems("prod", testConfig);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("prod");
    expect(result[0].source).toBe("flag");
    expect(result[0].config.host).toBe("prod400.com");
  });
});
