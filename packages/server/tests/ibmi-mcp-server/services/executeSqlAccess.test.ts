/**
 * @fileoverview Tests for the execute_sql guardrail mode: env parsing
 * (IBMI_EXECUTE_SQL_ACCESS, the deprecated IBMI_EXECUTE_SQL_READONLY, the two
 * pattern gates), the ceiling, and the JDBC access mapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_VARS = [
  "IBMI_EXECUTE_SQL_ACCESS",
  "IBMI_EXECUTE_SQL_READONLY",
  "IBMI_EXECUTE_SQL_FORBIDDEN_FUNCTIONS",
  "IBMI_EXECUTE_SQL_FORBIDDEN_KEYWORDS",
];

/** Load fresh config + access modules with the given env. */
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const name of ENV_VARS) vi.stubEnv(name, env[name]);
  const { config } = await import("../../../src/config/index.js");
  const access =
    await import("../../../src/ibmi-mcp-server/services/executeSqlAccess.js");
  return { config, ...access };
}

describe("execute_sql guardrail config", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    stderr.mockRestore();
    vi.unstubAllEnvs();
  });

  it("defaults to read with no ceiling, QCMDEXC forbidden, no keywords", async () => {
    const { config } = await load({});
    expect(config.ibmi_executeSqlAccess).toBe("read");
    expect(config.ibmi_executeSqlAccessCeiling).toBeUndefined();
    expect(config.ibmi_executeSqlForbiddenFunctions).toEqual(["QCMDEXC"]);
    expect(config.ibmi_executeSqlForbiddenKeywords).toEqual([]);
  });

  it("IBMI_EXECUTE_SQL_ACCESS sets the default and the ceiling", async () => {
    const { config } = await load({ IBMI_EXECUTE_SQL_ACCESS: " Read-Call " });
    expect(config.ibmi_executeSqlAccess).toBe("read-call");
    expect(config.ibmi_executeSqlAccessCeiling).toBe("read-call");
  });

  it("an unrecognized value fails closed to read with a stderr warning", async () => {
    const { config } = await load({ IBMI_EXECUTE_SQL_ACCESS: "readwrite" });
    expect(config.ibmi_executeSqlAccess).toBe("read");
    expect(config.ibmi_executeSqlAccessCeiling).toBe("read");
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unrecognized IBMI_EXECUTE_SQL_ACCESS="readwrite"',
      ),
    );
  });

  it("deprecated IBMI_EXECUTE_SQL_READONLY seeds the default only", async () => {
    const { config } = await load({ IBMI_EXECUTE_SQL_READONLY: "false" });
    expect(config.ibmi_executeSqlAccess).toBe("write");
    expect(config.ibmi_executeSqlAccessCeiling).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("IBMI_EXECUTE_SQL_READONLY is deprecated"),
    );

    const legacyTrue = await load({ IBMI_EXECUTE_SQL_READONLY: "true" });
    expect(legacyTrue.config.ibmi_executeSqlAccess).toBe("read");
    expect(legacyTrue.config.ibmi_executeSqlAccessCeiling).toBeUndefined();
  });

  it("IBMI_EXECUTE_SQL_ACCESS wins over the deprecated variable", async () => {
    const { config } = await load({
      IBMI_EXECUTE_SQL_ACCESS: "read",
      IBMI_EXECUTE_SQL_READONLY: "false",
    });
    expect(config.ibmi_executeSqlAccess).toBe("read");
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        "IBMI_EXECUTE_SQL_READONLY is deprecated and ignored",
      ),
    );
  });

  it("parses the pattern lists; an empty functions value disables the gate", async () => {
    const { config } = await load({
      IBMI_EXECUTE_SQL_FORBIDDEN_FUNCTIONS: " QCMDEXC , HTTP_* ,",
      IBMI_EXECUTE_SQL_FORBIDDEN_KEYWORDS: "DROP, payroll.*",
    });
    expect(config.ibmi_executeSqlForbiddenFunctions).toEqual([
      "QCMDEXC",
      "HTTP_*",
    ]);
    expect(config.ibmi_executeSqlForbiddenKeywords).toEqual([
      "DROP",
      "payroll.*",
    ]);

    const disabled = await load({ IBMI_EXECUTE_SQL_FORBIDDEN_FUNCTIONS: "" });
    expect(disabled.config.ibmi_executeSqlForbiddenFunctions).toEqual([]);
  });
});

describe("execute_sql access policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("without a ceiling, runtime configuration is authoritative", async () => {
    const { setExecuteSqlAccessPolicy, getExecuteSqlAccessPolicy } = await load(
      { IBMI_EXECUTE_SQL_READONLY: "true" },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(setExecuteSqlAccessPolicy("write")).toBe("write");
    expect(getExecuteSqlAccessPolicy()).toBe("write");
    expect(setExecuteSqlAccessPolicy("read")).toBe("read");
  });

  it("an explicit IBMI_EXECUTE_SQL_ACCESS is a ceiling that can only be lowered", async () => {
    const { setExecuteSqlAccessPolicy, getExecuteSqlAccessCeiling } =
      await load({ IBMI_EXECUTE_SQL_ACCESS: "read-call" });
    expect(getExecuteSqlAccessCeiling()).toBe("read-call");
    expect(setExecuteSqlAccessPolicy("write")).toBe("read-call");
    expect(setExecuteSqlAccessPolicy("read")).toBe("read");
  });

  it("orders, parses and maps modes", async () => {
    const {
      accessAtLeast,
      minAccess,
      parseExecuteSqlAccess,
      accessFromLegacyReadOnly,
      jdbcAccessFor,
    } = await load({});
    expect(accessAtLeast("write", "read-call")).toBe(true);
    expect(accessAtLeast("read", "read-call")).toBe(false);
    expect(minAccess("write", "read")).toBe("read");
    expect(parseExecuteSqlAccess(" WRITE ")).toBe("write");
    expect(parseExecuteSqlAccess("all")).toBeUndefined();
    expect(accessFromLegacyReadOnly(true)).toBe("read");
    expect(accessFromLegacyReadOnly(false)).toBe("write");
    expect(accessFromLegacyReadOnly(undefined)).toBeUndefined();
    expect(jdbcAccessFor("read")).toBe("read call");
    expect(jdbcAccessFor("read-call")).toBe("read call");
    expect(jdbcAccessFor("write")).toBe("all");
  });
});
