import { describe, it, expect } from "vitest";
import {
  CliConfigSchema,
  SystemConfigSchema,
  validateConfig,
} from "../../../src/cli/config/schema";

describe("SystemConfigSchema", () => {
  it("should validate a minimal system config", () => {
    const result = SystemConfigSchema.safeParse({
      host: "myhost.com",
      user: "MYUSER",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.port).toBe(8076);
      expect(result.data.readOnly).toBe(false);
      expect(result.data.timeout).toBe(60);
      expect(result.data.maxRows).toBe(5000);
      expect(result.data.ignoreUnauthorized).toBe(true);
    }
  });

  it("should validate a full system config", () => {
    const result = SystemConfigSchema.safeParse({
      description: "Production system",
      host: "prod400.example.com",
      port: 8077,
      user: "SVCACCT",
      password: "${PROD_PASSWORD}",
      defaultSchema: "PRODLIB",
      readOnly: true,
      confirm: true,
      timeout: 30,
      maxRows: 1000,
      ignoreUnauthorized: false,
      tools: ["./tools/custom.yaml"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.readOnly).toBe(true);
      expect(result.data.port).toBe(8077);
      expect(result.data.tools).toEqual(["./tools/custom.yaml"]);
    }
  });

  it("should reject missing host", () => {
    const result = SystemConfigSchema.safeParse({ user: "TEST" });
    expect(result.success).toBe(false);
  });

  it("should reject missing user", () => {
    const result = SystemConfigSchema.safeParse({ host: "myhost.com" });
    expect(result.success).toBe(false);
  });

  it("should coerce string port to number", () => {
    const result = SystemConfigSchema.safeParse({
      host: "myhost.com",
      user: "TEST",
      port: "8077",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.port).toBe(8077);
    }
  });
});

describe("CliConfigSchema", () => {
  it("should validate an empty config", () => {
    const result = CliConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.systems).toEqual({});
    }
  });

  it("should validate a config with systems", () => {
    const result = CliConfigSchema.safeParse({
      default: "dev",
      systems: {
        dev: { host: "dev400.com", user: "DEV" },
        prod: { host: "prod400.com", user: "PROD", readOnly: true },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.default).toBe("dev");
      expect(Object.keys(result.data.systems)).toHaveLength(2);
    }
  });
});

describe("validateConfig", () => {
  it("should pass when default references valid system", () => {
    const config = CliConfigSchema.parse({
      default: "dev",
      systems: { dev: { host: "dev400.com", user: "DEV" } },
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it("should fail when default references non-existent system", () => {
    const config = CliConfigSchema.parse({
      default: "missing",
      systems: { dev: { host: "dev400.com", user: "DEV" } },
    });
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing");
  });

  it("should pass with no default set", () => {
    const config = CliConfigSchema.parse({
      systems: { dev: { host: "dev400.com", user: "DEV" } },
    });
    expect(validateConfig(config)).toEqual([]);
  });
});
