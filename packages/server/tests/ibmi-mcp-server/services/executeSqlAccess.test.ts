/**
 * Tests for the execute_sql access mode (read | read-call | write): the
 * lattice helpers, env resolution in config, and the env-ceiling semantics
 * shared between the execute_sql tool config and the singleton pool's JDBC
 * access.
 *
 * The env ceiling (`ENV_PINNED_ACCESS`) is computed at module load from
 * `process.env`, so ceiling tests stub the env, reset the module registry and
 * dynamically import fresh module instances.
 *
 * @module tests/ibmi-mcp-server/services/executeSqlAccess.test
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  EXECUTE_SQL_ACCESS_LEVELS,
  DEFAULT_EXECUTE_SQL_ACCESS,
  EXECUTE_SQL_ACCESS_ENV,
  LEGACY_READONLY_ENV,
  accessAtLeast,
  accessFromLegacyReadOnly,
  jdbcAccessFor,
  minAccess,
  parseExecuteSqlAccess,
  resolveAccess,
} from "../../../src/ibmi-mcp-server/services/executeSqlAccess.js";

const ACCESS_MODULE =
  "../../../src/ibmi-mcp-server/services/executeSqlAccess.js";
const CONFIG_MODULE = "../../../src/config/index.js";
const TOOL_MODULE = "../../../src/ibmi-mcp-server/tools/executeSql.tool.js";

/**
 * Stub the two access-related env vars. `undefined` removes a variable so the
 * "unset" case is deterministic regardless of the developer's shell.
 */
function stubAccessEnv(
  access: string | undefined,
  legacyReadOnly: string | undefined,
) {
  vi.stubEnv(EXECUTE_SQL_ACCESS_ENV, access);
  vi.stubEnv(LEGACY_READONLY_ENV, legacyReadOnly);
}

async function freshAccessModule() {
  vi.resetModules();
  return import(ACCESS_MODULE);
}

async function freshConfig() {
  vi.resetModules();
  const { config } = await import(CONFIG_MODULE);
  return config;
}

async function freshToolModule() {
  vi.resetModules();
  return import(TOOL_MODULE);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("executeSqlAccess – lattice helpers", () => {
  it("orders levels least to most permissive", () => {
    expect(EXECUTE_SQL_ACCESS_LEVELS).toEqual(["read", "read-call", "write"]);
    expect(DEFAULT_EXECUTE_SQL_ACCESS).toBe("read");
  });

  it("accessAtLeast is reflexive and follows the order", () => {
    expect(accessAtLeast("read", "read")).toBe(true);
    expect(accessAtLeast("read-call", "read")).toBe(true);
    expect(accessAtLeast("write", "read-call")).toBe(true);
    expect(accessAtLeast("write", "write")).toBe(true);
    expect(accessAtLeast("read", "read-call")).toBe(false);
    expect(accessAtLeast("read-call", "write")).toBe(false);
  });

  it("minAccess picks the more restrictive level", () => {
    expect(minAccess("read", "write")).toBe("read");
    expect(minAccess("write", "read")).toBe("read");
    expect(minAccess("read-call", "write")).toBe("read-call");
    expect(minAccess("write", "read-call")).toBe("read-call");
    expect(minAccess("read", "read-call")).toBe("read");
    expect(minAccess("write", "write")).toBe("write");
  });
});

describe("executeSqlAccess – parseExecuteSqlAccess", () => {
  it("accepts each level verbatim", () => {
    expect(parseExecuteSqlAccess("read")).toBe("read");
    expect(parseExecuteSqlAccess("read-call")).toBe("read-call");
    expect(parseExecuteSqlAccess("write")).toBe("write");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseExecuteSqlAccess("READ")).toBe("read");
    expect(parseExecuteSqlAccess(" Read-Call ")).toBe("read-call");
    expect(parseExecuteSqlAccess("\tWRITE\n")).toBe("write");
  });

  it("returns undefined for unknown values and undefined input", () => {
    expect(parseExecuteSqlAccess(undefined)).toBeUndefined();
    expect(parseExecuteSqlAccess("")).toBeUndefined();
    expect(parseExecuteSqlAccess("readonly")).toBeUndefined();
    expect(parseExecuteSqlAccess("read call")).toBeUndefined();
    expect(parseExecuteSqlAccess("all")).toBeUndefined();
    expect(parseExecuteSqlAccess("true")).toBeUndefined();
  });
});

describe("executeSqlAccess – accessFromLegacyReadOnly", () => {
  it("maps true → read, false → write, undefined → undefined", () => {
    expect(accessFromLegacyReadOnly(true)).toBe("read");
    expect(accessFromLegacyReadOnly(false)).toBe("write");
    expect(accessFromLegacyReadOnly(undefined)).toBeUndefined();
  });
});

describe("executeSqlAccess – resolveAccess", () => {
  it("access wins over readOnly when both are present", () => {
    expect(resolveAccess({ access: "read-call", readOnly: false })).toBe(
      "read-call",
    );
    expect(resolveAccess({ access: "write", readOnly: true })).toBe("write");
    expect(resolveAccess({ access: "read", readOnly: false })).toBe("read");
  });

  it("falls back to the deprecated readOnly flag", () => {
    expect(resolveAccess({ readOnly: true })).toBe("read");
    expect(resolveAccess({ readOnly: false })).toBe("write");
  });

  it("neither → read (fail-closed)", () => {
    expect(resolveAccess(undefined)).toBe("read");
    expect(resolveAccess({})).toBe("read");
    expect(resolveAccess({ access: undefined, readOnly: undefined })).toBe(
      "read",
    );
  });
});

describe("executeSqlAccess – jdbcAccessFor", () => {
  it("read and read-call → 'read call'; write → 'all'", () => {
    expect(jdbcAccessFor("read")).toBe("read call");
    expect(jdbcAccessFor("read-call")).toBe("read call");
    expect(jdbcAccessFor("write")).toBe("all");
  });
});

// ---------------------------------------------------------------------------
// Config resolution from the environment
// ---------------------------------------------------------------------------
describe("config.ibmi_executeSqlAccess – env resolution", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to read when neither variable is set", async () => {
    stubAccessEnv(undefined, undefined);
    const config = await freshConfig();
    expect(config.ibmi_executeSqlAccess).toBe("read");
  });

  it.each(["read", "read-call", "write"] as const)(
    "IBMI_EXECUTE_SQL_ACCESS=%s is honoured",
    async (level) => {
      stubAccessEnv(level, undefined);
      const config = await freshConfig();
      expect(config.ibmi_executeSqlAccess).toBe(level);
    },
  );

  it("normalises case and whitespace", async () => {
    stubAccessEnv("  Read-Call ", undefined);
    const config = await freshConfig();
    expect(config.ibmi_executeSqlAccess).toBe("read-call");
  });

  it("unknown value → read with a stderr warning", async () => {
    stubAccessEnv("everything", undefined);
    const config = await freshConfig();
    expect(config.ibmi_executeSqlAccess).toBe("read");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unrecognized IBMI_EXECUTE_SQL_ACCESS="everything"',
      ),
    );
  });

  it("legacy IBMI_EXECUTE_SQL_READONLY=true → read with a deprecation notice", async () => {
    stubAccessEnv(undefined, "true");
    const config = await freshConfig();
    expect(config.ibmi_executeSqlAccess).toBe("read");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("IBMI_EXECUTE_SQL_READONLY is deprecated"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("IBMI_EXECUTE_SQL_ACCESS=read"),
    );
  });

  it("legacy IBMI_EXECUTE_SQL_READONLY=false → write with a deprecation notice", async () => {
    stubAccessEnv(undefined, "false");
    const config = await freshConfig();
    expect(config.ibmi_executeSqlAccess).toBe("write");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("IBMI_EXECUTE_SQL_ACCESS=write"),
    );
  });

  it("legacy IBMI_EXECUTE_SQL_READONLY=0 → write; any other value → read", async () => {
    stubAccessEnv(undefined, "0");
    expect((await freshConfig()).ibmi_executeSqlAccess).toBe("write");

    stubAccessEnv(undefined, "yes");
    expect((await freshConfig()).ibmi_executeSqlAccess).toBe("read");
  });

  it("IBMI_EXECUTE_SQL_ACCESS wins when both are set (no deprecation notice)", async () => {
    stubAccessEnv("read-call", "false");
    const config = await freshConfig();
    expect(config.ibmi_executeSqlAccess).toBe("read-call");
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("IBMI_EXECUTE_SQL_READONLY is deprecated"),
    );
  });
});

// ---------------------------------------------------------------------------
// Env ceiling semantics
// ---------------------------------------------------------------------------
describe("executeSqlAccess – env ceiling", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("env unset: no ceiling, runtime configuration is authoritative", async () => {
    stubAccessEnv(undefined, undefined);
    const access = await freshAccessModule();

    expect(access.getExecuteSqlAccessCeiling()).toBeUndefined();
    expect(access.getExecuteSqlAccessPolicy()).toBe("read");

    expect(access.setExecuteSqlAccessPolicy("write")).toBe("write");
    expect(access.getExecuteSqlAccessPolicy()).toBe("write");

    expect(access.setExecuteSqlAccessPolicy("read-call")).toBe("read-call");
    expect(access.setExecuteSqlAccessPolicy("read")).toBe("read");
    expect(access.getExecuteSqlAccessPolicy()).toBe("read");
  });

  it("env read: requesting write or read-call is lowered to read", async () => {
    stubAccessEnv("read", undefined);
    const access = await freshAccessModule();

    expect(access.getExecuteSqlAccessCeiling()).toBe("read");
    expect(access.setExecuteSqlAccessPolicy("write")).toBe("read");
    expect(access.getExecuteSqlAccessPolicy()).toBe("read");
    expect(access.setExecuteSqlAccessPolicy("read-call")).toBe("read");
    expect(access.setExecuteSqlAccessPolicy("read")).toBe("read");
  });

  it("env read-call: write → read-call, read → read", async () => {
    stubAccessEnv("read-call", undefined);
    const access = await freshAccessModule();

    expect(access.getExecuteSqlAccessCeiling()).toBe("read-call");
    expect(access.getExecuteSqlAccessPolicy()).toBe("read-call");
    expect(access.setExecuteSqlAccessPolicy("write")).toBe("read-call");
    expect(access.setExecuteSqlAccessPolicy("read")).toBe("read");
    expect(access.getExecuteSqlAccessPolicy()).toBe("read");
    expect(access.setExecuteSqlAccessPolicy("read-call")).toBe("read-call");
  });

  it("env write: every requested level is honoured as-is", async () => {
    stubAccessEnv("write", undefined);
    const access = await freshAccessModule();

    expect(access.getExecuteSqlAccessCeiling()).toBe("write");
    expect(access.setExecuteSqlAccessPolicy("read")).toBe("read");
    expect(access.setExecuteSqlAccessPolicy("read-call")).toBe("read-call");
    expect(access.setExecuteSqlAccessPolicy("write")).toBe("write");
  });

  it("legacy IBMI_EXECUTE_SQL_READONLY=true pins the ceiling at read", async () => {
    stubAccessEnv(undefined, "true");
    const access = await freshAccessModule();

    expect(access.getExecuteSqlAccessCeiling()).toBe("read");
    expect(access.setExecuteSqlAccessPolicy("write")).toBe("read");
  });

  it("configureExecuteSqlTool({readOnly:false}) with no env pin yields write", async () => {
    stubAccessEnv(undefined, undefined);
    const tool = await freshToolModule();
    const access = await import(ACCESS_MODULE);

    const effective = tool.configureExecuteSqlTool({
      security: { readOnly: false },
    });

    expect(effective).toBe("write");
    expect(tool.getExecuteSqlConfig().security?.access).toBe("write");
    expect(access.getExecuteSqlAccessPolicy()).toBe("write");
  });

  it("configureExecuteSqlTool({readOnly:false}) with env pin read returns read", async () => {
    stubAccessEnv("read", undefined);
    const tool = await freshToolModule();
    const access = await import(ACCESS_MODULE);

    const effective = tool.configureExecuteSqlTool({
      security: { readOnly: false },
    });

    expect(effective).toBe("read");
    expect(tool.getExecuteSqlConfig().security?.access).toBe("read");
    expect(access.getExecuteSqlAccessPolicy()).toBe("read");
  });

  it("configureExecuteSqlTool({access:'write'}) with env pin read-call returns read-call", async () => {
    stubAccessEnv("read-call", undefined);
    const tool = await freshToolModule();

    expect(
      tool.configureExecuteSqlTool({ security: { access: "write" } }),
    ).toBe("read-call");
    expect(tool.configureExecuteSqlTool({ security: { access: "read" } })).toBe(
      "read",
    );
  });

  it("unrelated configure calls keep the current access level", async () => {
    stubAccessEnv(undefined, undefined);
    const tool = await freshToolModule();
    const access = await import(ACCESS_MODULE);

    tool.configureExecuteSqlTool({ security: { access: "read-call" } });
    tool.configureExecuteSqlTool({ enabled: true });

    expect(tool.getExecuteSqlConfig().security?.access).toBe("read-call");
    expect(access.getExecuteSqlAccessPolicy()).toBe("read-call");
  });
});
