import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  ACCESS_ENV,
  ACCESS_MODES,
  accessFromFlags,
  accessFromReadOnly,
  assertAccessNotLowered,
  minAccess,
  parseAccessMode,
  resolveEffectiveAccess,
  resolveSystemAccess,
} from "../../src/utils/access-mode";

describe("ACCESS_MODES", () => {
  it("should list the three levels from least to most permissive", () => {
    expect(ACCESS_MODES).toEqual(["read", "read-call", "write"]);
  });

  it("should name the server's access env var", () => {
    expect(ACCESS_ENV).toBe("IBMI_EXECUTE_SQL_ACCESS");
  });
});

describe("minAccess", () => {
  it("should return the same mode when both are equal", () => {
    expect(minAccess("read", "read")).toBe("read");
    expect(minAccess("read-call", "read-call")).toBe("read-call");
    expect(minAccess("write", "write")).toBe("write");
  });

  it("should return the more restrictive mode regardless of order", () => {
    expect(minAccess("read", "write")).toBe("read");
    expect(minAccess("write", "read")).toBe("read");
    expect(minAccess("read-call", "write")).toBe("read-call");
    expect(minAccess("write", "read-call")).toBe("read-call");
    expect(minAccess("read", "read-call")).toBe("read");
    expect(minAccess("read-call", "read")).toBe("read");
  });
});

describe("parseAccessMode", () => {
  it("should accept each valid mode", () => {
    expect(parseAccessMode("read")).toBe("read");
    expect(parseAccessMode("read-call")).toBe("read-call");
    expect(parseAccessMode("write")).toBe("write");
  });

  it("should trim and lowercase", () => {
    expect(parseAccessMode("  WRITE ")).toBe("write");
    expect(parseAccessMode("Read-Call")).toBe("read-call");
  });

  it("should return undefined for unrecognised strings", () => {
    expect(parseAccessMode("admin")).toBeUndefined();
    expect(parseAccessMode("readonly")).toBeUndefined();
    expect(parseAccessMode("")).toBeUndefined();
  });

  it("should return undefined for non-string input", () => {
    expect(parseAccessMode(undefined)).toBeUndefined();
    expect(parseAccessMode(null)).toBeUndefined();
    expect(parseAccessMode(true)).toBeUndefined();
    expect(parseAccessMode(1)).toBeUndefined();
  });
});

describe("accessFromReadOnly", () => {
  it("should map true to read", () => {
    expect(accessFromReadOnly(true)).toBe("read");
  });

  it("should map false to write", () => {
    expect(accessFromReadOnly(false)).toBe("write");
  });

  it("should map undefined to undefined", () => {
    expect(accessFromReadOnly(undefined)).toBeUndefined();
  });
});

describe("resolveSystemAccess", () => {
  it("should return undefined when the system declares no ceiling", () => {
    expect(resolveSystemAccess({})).toBeUndefined();
  });

  it("should return the declared access", () => {
    expect(resolveSystemAccess({ access: "read-call" })).toBe("read-call");
  });

  it("should map the legacy readOnly flag", () => {
    expect(resolveSystemAccess({ readOnly: true })).toBe("read");
    expect(resolveSystemAccess({ readOnly: false })).toBe("write");
  });

  it("should prefer access over readOnly when both are set", () => {
    expect(resolveSystemAccess({ access: "write", readOnly: true })).toBe(
      "write",
    );
    expect(resolveSystemAccess({ access: "read", readOnly: false })).toBe(
      "read",
    );
  });
});

describe("accessFromFlags", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("should return undefined when no access flag is given", () => {
    expect(accessFromFlags({})).toBeUndefined();
    expect(accessFromFlags({ limit: "10" })).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("should return the parsed --access value without a warning", () => {
    expect(accessFromFlags({ access: "read-call" })).toBe("read-call");
    expect(accessFromFlags({ access: "WRITE" })).toBe("write");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("should throw on an invalid --access value", () => {
    expect(() => accessFromFlags({ access: "admin" })).toThrow(
      /Invalid --access value: "admin"/,
    );
    expect(() => accessFromFlags({ access: "admin" })).toThrow(
      /read, read-call, write/,
    );
  });

  it("should map deprecated --read-only to read and warn on stderr", () => {
    expect(accessFromFlags({ readOnly: true })).toBe("read");
    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = String(stderrSpy.mock.calls[0]?.[0]);
    expect(written).toMatch(/deprecated/i);
    expect(written).toContain("--access read");
  });

  it("should map deprecated --no-read-only to write and warn on stderr", () => {
    expect(accessFromFlags({ readOnly: false })).toBe("write");
    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = String(stderrSpy.mock.calls[0]?.[0]);
    expect(written).toMatch(/deprecated/i);
    expect(written).toContain("--access write");
  });

  it("should let --access win over the deprecated flags", () => {
    expect(accessFromFlags({ access: "read-call", readOnly: true })).toBe(
      "read-call",
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("should ignore a non-boolean readOnly value", () => {
    expect(accessFromFlags({ readOnly: "yes" })).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("resolveEffectiveAccess", () => {
  it("should default to read with no flag and no ceiling", () => {
    expect(resolveEffectiveAccess(undefined, [])).toBe("read");
    expect(resolveEffectiveAccess(undefined, [{}])).toBe("read");
  });

  it("should never raise the default read request to a wider system ceiling", () => {
    expect(resolveEffectiveAccess(undefined, [{ access: "read-call" }])).toBe(
      "read",
    );
    expect(resolveEffectiveAccess(undefined, [{ access: "write" }])).toBe(
      "read",
    );
    expect(resolveEffectiveAccess(undefined, [{ access: "read" }])).toBe(
      "read",
    );
  });

  it("should use the flag when no system declares a ceiling", () => {
    expect(resolveEffectiveAccess("write", [])).toBe("write");
    expect(resolveEffectiveAccess("write", [{}])).toBe("write");
    expect(resolveEffectiveAccess("read-call", [{}])).toBe("read-call");
  });

  it("should lower the flag to the system ceiling", () => {
    expect(resolveEffectiveAccess("write", [{ access: "read-call" }])).toBe(
      "read-call",
    );
    expect(resolveEffectiveAccess("write", [{ access: "read" }])).toBe("read");
    expect(resolveEffectiveAccess("read-call", [{ access: "read" }])).toBe(
      "read",
    );
  });

  it("should not raise the flag to a higher system ceiling", () => {
    expect(resolveEffectiveAccess("read", [{ access: "write" }])).toBe("read");
    expect(resolveEffectiveAccess("read-call", [{ access: "write" }])).toBe(
      "read-call",
    );
  });

  it("should apply the most restrictive ceiling across several systems", () => {
    const systems = [
      { access: "write" as const },
      { access: "read-call" as const },
      {},
    ];
    expect(resolveEffectiveAccess("write", systems)).toBe("read-call");
    expect(resolveEffectiveAccess("read-call", systems)).toBe("read-call");
    expect(resolveEffectiveAccess(undefined, systems)).toBe("read");

    const withRead = [...systems, { access: "read" as const }];
    expect(resolveEffectiveAccess("write", withRead)).toBe("read");
    expect(resolveEffectiveAccess("read-call", withRead)).toBe("read");
  });

  it("should ignore systems without a ceiling when others declare one", () => {
    expect(resolveEffectiveAccess("write", [{}, { access: "write" }])).toBe(
      "write",
    );
    expect(resolveEffectiveAccess("write", [{}, { access: "read-call" }])).toBe(
      "read-call",
    );
  });

  it("should treat legacy readOnly on a system as a ceiling", () => {
    expect(resolveEffectiveAccess("write", [{ readOnly: true }])).toBe("read");
    expect(resolveEffectiveAccess("read-call", [{ readOnly: true }])).toBe(
      "read",
    );
    expect(resolveEffectiveAccess(undefined, [{ readOnly: true }])).toBe(
      "read",
    );
    // readOnly: false is a `write` ceiling, which lets a write request through
    // but does not raise the default read request.
    expect(resolveEffectiveAccess("write", [{ readOnly: false }])).toBe(
      "write",
    );
    expect(resolveEffectiveAccess(undefined, [{ readOnly: false }])).toBe(
      "read",
    );
    expect(
      resolveEffectiveAccess("write", [
        { access: "write" },
        { readOnly: true },
      ]),
    ).toBe("read");
  });
});

describe("assertAccessNotLowered", () => {
  const originalEnv = process.env[ACCESS_ENV];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ACCESS_ENV];
    } else {
      process.env[ACCESS_ENV] = originalEnv;
    }
  });

  it("should be a no-op when requested equals effective", () => {
    for (const mode of ACCESS_MODES) {
      expect(() => assertAccessNotLowered(mode, mode)).not.toThrow();
    }
  });

  it("should throw a message containing 'access mode' when lowered", () => {
    expect(() => assertAccessNotLowered("write", "read")).toThrow(
      /access mode/,
    );
    expect(() => assertAccessNotLowered("read-call", "read")).toThrow(
      /access mode/,
    );
  });

  it("should name both modes and the env var in the message", () => {
    process.env[ACCESS_ENV] = "read";
    expect(() => assertAccessNotLowered("write", "read")).toThrow(
      /Requested access mode 'write'.*IBMI_EXECUTE_SQL_ACCESS=read.*caps execute_sql at 'read'.*--access read/,
    );
  });

  it("should point at the legacy env var when IBMI_EXECUTE_SQL_ACCESS is unset", () => {
    delete process.env[ACCESS_ENV];
    expect(() => assertAccessNotLowered("write", "read-call")).toThrow(
      /IBMI_EXECUTE_SQL_READONLY/,
    );
  });
});
