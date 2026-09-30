import { describe, it, expect, vi, afterEach } from "vitest";
import { EXECUTE_SQL_ACCESS_LEVELS } from "@ibm/ibmi-mcp-server/tools";
import { ACCESS_MODES } from "../../src/config/schema";
import {
  accessFromFlags,
  assertNotLoweredByEnv,
  assertWithinSystemCeilings,
  systemAccessCeiling,
} from "../../src/utils/access-mode";
import { SecurityViolationError } from "../../src/utils/exit-codes";
import type { ResolvedSystem, SystemConfig } from "../../src/config/types";

function system(name: string, extra: Partial<SystemConfig>): ResolvedSystem {
  return {
    name,
    source: "flag",
    config: {
      host: `${name}.example.com`,
      port: 8076,
      user: "U",
      readOnly: false,
      confirm: false,
      timeout: 60,
      maxRows: 5000,
      ignoreUnauthorized: true,
      ...extra,
    },
  };
}

function captureStderr(): { text: () => string } {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  return { text: () => writes.join("") };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["IBMI_EXECUTE_SQL_ACCESS"];
});

describe("ACCESS_MODES", () => {
  it("matches the server's guardrail modes", () => {
    expect([...ACCESS_MODES]).toEqual([...EXECUTE_SQL_ACCESS_LEVELS]);
  });
});

describe("accessFromFlags", () => {
  it("defaults to read", () => {
    expect(accessFromFlags({})).toBe("read");
  });

  it("accepts each mode, case-insensitively", () => {
    expect(accessFromFlags({ access: "read" })).toBe("read");
    expect(accessFromFlags({ access: "READ-CALL" })).toBe("read-call");
    expect(accessFromFlags({ access: " write " })).toBe("write");
  });

  it("rejects an unrecognized value", () => {
    expect(() => accessFromFlags({ access: "readonly" })).toThrow(
      'Invalid --access value: "readonly". Expected one of: read, read-call, write.',
    );
  });

  it("maps the deprecated flags with a stderr notice", () => {
    const stderr = captureStderr();
    expect(accessFromFlags({ readOnly: true })).toBe("read");
    expect(accessFromFlags({ readOnly: false })).toBe("write");
    expect(stderr.text()).toContain("deprecated; use --access read");
    expect(stderr.text()).toContain("deprecated; use --access write");
  });

  it("prefers --access over the deprecated flags", () => {
    const stderr = captureStderr();
    expect(accessFromFlags({ access: "read-call", readOnly: false })).toBe(
      "read-call",
    );
    expect(stderr.text()).toBe("");
  });
});

describe("systemAccessCeiling", () => {
  it("is undefined when nothing is configured", () => {
    expect(systemAccessCeiling({ readOnly: false })).toBeUndefined();
  });

  it("maps the deprecated readOnly: true to read", () => {
    expect(systemAccessCeiling({ readOnly: true })).toBe("read");
  });

  it("uses access, and the more restrictive of the two when both are set", () => {
    expect(systemAccessCeiling({ access: "read-call", readOnly: false })).toBe(
      "read-call",
    );
    expect(systemAccessCeiling({ access: "write", readOnly: true })).toBe(
      "read",
    );
  });
});

describe("assertWithinSystemCeilings", () => {
  it("allows a request at or below every ceiling", () => {
    expect(() =>
      assertWithinSystemCeilings("read-call", [
        system("dev", {}),
        system("test", { access: "read-call" }),
      ]),
    ).not.toThrow();
  });

  it("refuses a request above a system's access", () => {
    const run = () =>
      assertWithinSystemCeilings("write", [
        system("dev", {}),
        system("prod", { access: "read-call" }),
      ]);
    expect(run).toThrow(SecurityViolationError);
    expect(run).toThrow(
      `Guardrail mode 'write' is above the ceiling of system "prod" (access: read-call in its CLI config). Use --access read-call`,
    );
  });

  it("names readOnly when that is the ceiling", () => {
    expect(() =>
      assertWithinSystemCeilings("read-call", [
        system("prod", { readOnly: true }),
      ]),
    ).toThrow("(readOnly: true in its CLI config)");
  });
});

describe("assertNotLoweredByEnv", () => {
  it("does nothing when the mode was not lowered", () => {
    expect(() =>
      assertNotLoweredByEnv("write", "write", "IBMI_EXECUTE_SQL_ACCESS"),
    ).not.toThrow();
  });

  it("names the variable and its value", () => {
    process.env["IBMI_EXECUTE_SQL_ACCESS"] = "read-call";
    const run = () =>
      assertNotLoweredByEnv("write", "read-call", "IBMI_EXECUTE_SQL_ACCESS");
    expect(run).toThrow(SecurityViolationError);
    expect(run).toThrow(
      "Guardrail mode 'write' is above the ceiling IBMI_EXECUTE_SQL_ACCESS=read-call",
    );
    expect(run).toThrow(
      "Use --access read-call or unset IBMI_EXECUTE_SQL_ACCESS",
    );
  });
});
