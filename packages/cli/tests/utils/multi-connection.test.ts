import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedSystem } from "../../src/config/types";

// Mock SourceManager before importing the module under test
const mockRegisterSource = vi.fn().mockResolvedValue(undefined);
const mockExecuteQuery = vi.fn();
const mockCloseAllSources = vi.fn().mockResolvedValue(undefined);

vi.mock("@ibm/ibmi-mcp-server/services", () => ({
  SourceManager: vi.fn().mockImplementation(() => ({
    registerSource: mockRegisterSource,
    executeQuery: mockExecuteQuery,
    closeAllSources: mockCloseAllSources,
  })),
}));

vi.mock("../../src/config/credentials.js", () => ({
  resolvePassword: vi.fn().mockResolvedValue("mock-password"),
}));

import { executeMultiSystem } from "../../src/utils/multi-connection";

function makeSystem(name: string, host: string): ResolvedSystem {
  return {
    name,
    config: {
      host,
      port: 8076,
      user: name.toUpperCase(),
      readOnly: false,
      confirm: false,
      timeout: 60,
      maxRows: 5000,
      ignoreUnauthorized: true,
    },
    source: "flag",
  };
}

describe("executeMultiSystem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return results from multiple systems", async () => {
    const systems = [makeSystem("dev", "dev400.com"), makeSystem("prod", "prod400.com")];

    const results = await executeMultiSystem(systems, async (sourceName) => {
      return {
        data: [{ SYSTEM: sourceName, VALUE: 42 }],
        meta: { rowCount: 1 },
      };
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.system).toBe("dev");
    expect(results[0]!.data).toEqual([{ SYSTEM: "dev", VALUE: 42 }]);
    expect(results[1]!.system).toBe("prod");
    expect(results[1]!.data).toEqual([{ SYSTEM: "prod", VALUE: 42 }]);
  });

  it("should register each system as a named source", async () => {
    const systems = [makeSystem("dev", "dev400.com"), makeSystem("prod", "prod400.com")];

    await executeMultiSystem(systems, async () => ({
      data: [],
      meta: { rowCount: 0 },
    }));

    expect(mockRegisterSource).toHaveBeenCalledTimes(2);
    expect(mockRegisterSource).toHaveBeenCalledWith(
      "dev",
      expect.objectContaining({ host: "dev400.com", user: "DEV", password: "mock-password" }),
    );
    expect(mockRegisterSource).toHaveBeenCalledWith(
      "prod",
      expect.objectContaining({ host: "prod400.com", user: "PROD", password: "mock-password" }),
    );
  });

  it("should capture errors from failed systems without crashing", async () => {
    const systems = [makeSystem("dev", "dev400.com"), makeSystem("prod", "prod400.com")];

    const results = await executeMultiSystem(systems, async (sourceName) => {
      if (sourceName === "prod") {
        throw new Error("Connection refused");
      }
      return { data: [{ OK: true }], meta: { rowCount: 1 } };
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.error).toBeUndefined();
    expect(results[0]!.data).toEqual([{ OK: true }]);
    expect(results[1]!.error).toBe("Connection refused");
    expect(results[1]!.data).toEqual([]);
    expect(results[1]!.rowCount).toBe(0);
  });

  it("should always close all sources even on error", async () => {
    const systems = [makeSystem("dev", "dev400.com")];

    await executeMultiSystem(systems, async () => {
      throw new Error("boom");
    });

    expect(mockCloseAllSources).toHaveBeenCalledTimes(1);
  });

  it("should include host and timing in results", async () => {
    const systems = [makeSystem("dev", "dev400.com")];

    const results = await executeMultiSystem(systems, async () => ({
      data: [{ X: 1 }],
      meta: { rowCount: 1 },
    }));

    expect(results[0]!.host).toBe("dev400.com");
    expect(results[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
