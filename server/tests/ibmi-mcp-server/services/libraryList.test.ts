/**
 * @fileoverview Tests for library list configuration across all layers
 * Covers: env var parsing, YAML schema validation, PoolConnectionConfig wiring,
 * mapepire Pool JDBC options, SourceManager registration, and IBMiConnectionPool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PoolConnectionConfig } from "../../../src/ibmi-mcp-server/services/baseConnectionPool.js";

// ---------------------------------------------------------------------------
// Hoisted mock state – vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------
const { mockPoolInstance, MockPool, mockGetRootCert } = vi.hoisted(() => {
  const mockPoolInstance = {
    init: vi.fn(),
    execute: vi.fn(),
    end: vi.fn(),
    query: vi.fn(),
  };
  return {
    mockPoolInstance,
    MockPool: vi.fn(() => mockPoolInstance),
    mockGetRootCert: vi.fn().mockResolvedValue("cert"),
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("../../../src/utils/scheduling/index.js", () => ({
  SchedulerService: { getInstance: vi.fn() },
  schedulerService: {},
}));

vi.mock("@ibm/mapepire-js", () => ({
  default: {
    Pool: MockPool,
    getRootCertificate: mockGetRootCert,
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { BaseConnectionPool } from "../../../src/ibmi-mcp-server/services/baseConnectionPool.js";
import { SourceManager } from "../../../src/ibmi-mcp-server/services/sourceManager.js";
import {
  SourceConfigSchema,
  SqlToolsConfigSchema,
} from "../../../src/ibmi-mcp-server/schemas/config.js";
import { config } from "../../../src/config/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class TestConnectionPool extends BaseConnectionPool<string> {
  async testInitializePool(
    poolId: string,
    poolConfig: PoolConnectionConfig,
    context: Record<string, unknown>,
  ) {
    return this.initializePool(poolId, poolConfig, context as never);
  }

  async testExecuteQuery(
    poolId: string,
    query: string,
    params?: unknown[],
    context?: Record<string, unknown>,
  ) {
    return this.executeQuery(
      poolId,
      query,
      params as never,
      context as never,
    );
  }

  getPoolsMap() {
    return this.pools;
  }
}

class TestSourceManager extends SourceManager {
  getPoolsMap() {
    return this.pools;
  }
}

const BASE_CONFIG: PoolConnectionConfig = {
  host: "test-host",
  user: "testuser",
  password: "testpass",
  port: 8076,
  ignoreUnauthorized: true,
};

const TEST_CONTEXT = {
  requestId: "lib-list-test",
  timestamp: new Date().toISOString(),
  operation: "Test",
};

const SUCCESSFUL_RESULT = {
  success: true,
  data: [{ result: 1 }],
  sql_rc: 0,
  execution_time: 50,
};

const ORIGINAL_IDLE_TIMEOUT = config.poolTimeouts.idleTimeoutMs;
const ORIGINAL_QUERY_TIMEOUT = config.poolTimeouts.queryTimeoutMs;

function resetMocks() {
  MockPool.mockClear();
  mockPoolInstance.init.mockReset().mockResolvedValue(undefined);
  mockPoolInstance.execute.mockReset().mockResolvedValue(SUCCESSFUL_RESULT);
  mockPoolInstance.end.mockReset().mockResolvedValue(undefined);
  mockPoolInstance.query.mockReset();
  mockGetRootCert.mockClear();
}

function restoreConfig() {
  config.poolTimeouts.idleTimeoutMs = ORIGINAL_IDLE_TIMEOUT;
  config.poolTimeouts.queryTimeoutMs = ORIGINAL_QUERY_TIMEOUT;
}

// ══════════���═════════════════════════════════��══════════════════════════════
// Group 1 – SourceConfigSchema library-list validation
// ════════════════════════��══════════════════════════════════════════════════
describe("SourceConfigSchema – library-list field", () => {
  const base = { host: "myhost", user: "myuser", password: "mypass" };

  it("1.1 – accepts an array of library names", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "library-list": ["MYLIB", "DEVDATA", "QGPL"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["library-list"]).toEqual(["MYLIB", "DEVDATA", "QGPL"]);
    }
  });

  it("1.2 – accepts a comma-separated string and transforms to array", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "library-list": "MYLIB, DEVDATA, QGPL",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["library-list"]).toEqual(["MYLIB", "DEVDATA", "QGPL"]);
    }
  });

  it("1.3 – accepts a single library as string", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "library-list": "MYLIB",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["library-list"]).toEqual(["MYLIB"]);
    }
  });

  it("1.4 – library-list is optional (omitting it succeeds)", () => {
    const result = SourceConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["library-list"]).toBeUndefined();
    }
  });

  it("1.5 – rejects empty strings in array", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "library-list": ["MYLIB", ""],
    });
    expect(result.success).toBe(false);
  });

  it("1.6 – handles comma-separated string with extra whitespace", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "library-list": "  MYLIB ,  DEVDATA  ,  QGPL  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["library-list"]).toEqual(["MYLIB", "DEVDATA", "QGPL"]);
    }
  });

  it("1.7 – filters out empty entries from comma-separated string", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "library-list": "MYLIB,,DEVDATA,",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["library-list"]).toEqual(["MYLIB", "DEVDATA"]);
    }
  });

  it("1.8 – empty string results in empty array", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "library-list": "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["library-list"]).toEqual([]);
    }
  });
});

// ═══════���════════════════��═════════════════════════════���════════════════════
// Group 2 – SqlToolsConfigSchema with library-list in sources
// ══════��════════════════════════════════════════════════════���═══════════════
describe("SqlToolsConfigSchema – library-list in YAML sources", () => {
  it("2.1 – full YAML config with library-list parses correctly", () => {
    const result = SqlToolsConfigSchema.safeParse({
      sources: {
        "dev-system": {
          host: "dev400.example.com",
          user: "DEVUSER",
          password: "devpass",
          port: 8076,
          "library-list": ["DEVLIB", "DEVDATA", "QGPL"],
        },
      },
      tools: {
        get_status: {
          source: "dev-system",
          description: "Get system status",
          statement: "SELECT * FROM QSYS2.SYSTEM_STATUS_INFO",
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sources!["dev-system"]["library-list"]).toEqual([
        "DEVLIB",
        "DEVDATA",
        "QGPL",
      ]);
    }
  });

  it("2.2 – YAML config without library-list still parses", () => {
    const result = SqlToolsConfigSchema.safeParse({
      sources: {
        "prod-system": {
          host: "prod400.example.com",
          user: "PRODUSER",
          password: "prodpass",
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// ═══════���═════════���═════════════════════════════════════��═══════════════════
// Group 3 – config.db2i library list from env var
// ══���═══════════════════════════════════════════��════════════════════════════
describe("config.db2i – DB2i_LIBRARY_LIST env var", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("3.1 – parses comma-separated DB2i_LIBRARY_LIST", () => {
    process.env.DB2i_HOST = "testhost";
    process.env.DB2i_USER = "testuser";
    process.env.DB2i_PASS = "testpass";
    process.env.DB2i_LIBRARY_LIST = "MYLIB,DEVDATA,QGPL";

    const db2i = config.db2i;
    expect(db2i).toBeDefined();
    expect(db2i!.libraryList).toEqual(["MYLIB", "DEVDATA", "QGPL"]);
  });

  it("3.2 – trims whitespace in library names", () => {
    process.env.DB2i_HOST = "testhost";
    process.env.DB2i_USER = "testuser";
    process.env.DB2i_PASS = "testpass";
    process.env.DB2i_LIBRARY_LIST = " MYLIB , DEVDATA , QGPL ";

    expect(config.db2i!.libraryList).toEqual(["MYLIB", "DEVDATA", "QGPL"]);
  });

  it("3.3 – filters empty entries", () => {
    process.env.DB2i_HOST = "testhost";
    process.env.DB2i_USER = "testuser";
    process.env.DB2i_PASS = "testpass";
    process.env.DB2i_LIBRARY_LIST = "MYLIB,,DEVDATA,";

    expect(config.db2i!.libraryList).toEqual(["MYLIB", "DEVDATA"]);
  });

  it("3.4 – omits libraryList when env var is not set", () => {
    process.env.DB2i_HOST = "testhost";
    process.env.DB2i_USER = "testuser";
    process.env.DB2i_PASS = "testpass";
    delete process.env.DB2i_LIBRARY_LIST;

    const db2i = config.db2i;
    expect(db2i).toBeDefined();
    expect(db2i!.libraryList).toBeUndefined();
  });

  it("3.5 – omits libraryList when env var is empty string", () => {
    process.env.DB2i_HOST = "testhost";
    process.env.DB2i_USER = "testuser";
    process.env.DB2i_PASS = "testpass";
    process.env.DB2i_LIBRARY_LIST = "";

    const db2i = config.db2i;
    expect(db2i).toBeDefined();
    expect(db2i!.libraryList).toBeUndefined();
  });

  it("3.6 – single library name works", () => {
    process.env.DB2i_HOST = "testhost";
    process.env.DB2i_USER = "testuser";
    process.env.DB2i_PASS = "testpass";
    process.env.DB2i_LIBRARY_LIST = "SINGLELIB";

    expect(config.db2i!.libraryList).toEqual(["SINGLELIB"]);
  });
});

// ═══════════════════════════════════════════════════════���═══════════════════
// Group 4 – BaseConnectionPool passes JDBC opts to mapepire Pool
// ═══════════���═════════════════════════════════��═════════════════════════════
describe("BaseConnectionPool – library list JDBC options", () => {
  let pool: TestConnectionPool;

  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();
    config.poolTimeouts.queryTimeoutMs = 0;
    config.poolTimeouts.idleTimeoutMs = 0;
  });

  afterEach(async () => {
    await BaseConnectionPool.shutdownAll();
    restoreConfig();
    vi.useRealTimers();
  });

  it("4.1 – passes libraries in opts when libraryList is configured", async () => {
    pool = new TestConnectionPool();
    const configWithLibs: PoolConnectionConfig = {
      ...BASE_CONFIG,
      libraryList: ["MYLIB", "DEVDATA", "QGPL"],
    };

    await pool.testInitializePool("test-libs", configWithLibs, TEST_CONTEXT);

    expect(MockPool).toHaveBeenCalledTimes(1);
    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toBeDefined();
    expect(poolArgs.opts.libraries).toEqual(["MYLIB", "DEVDATA", "QGPL"]);
  });

  it("4.2 – does not pass opts when libraryList is undefined", async () => {
    pool = new TestConnectionPool();
    await pool.testInitializePool("test-no-libs", BASE_CONFIG, TEST_CONTEXT);

    expect(MockPool).toHaveBeenCalledTimes(1);
    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toBeUndefined();
  });

  it("4.3 �� does not pass opts when libraryList is empty array", async () => {
    pool = new TestConnectionPool();
    const configWithEmpty: PoolConnectionConfig = {
      ...BASE_CONFIG,
      libraryList: [],
    };

    await pool.testInitializePool("test-empty", configWithEmpty, TEST_CONTEXT);

    expect(MockPool).toHaveBeenCalledTimes(1);
    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toBeUndefined();
  });

  it("4.4 – pool still initializes and executes queries with library list", async () => {
    pool = new TestConnectionPool();
    const configWithLibs: PoolConnectionConfig = {
      ...BASE_CONFIG,
      libraryList: ["MYLIB"],
    };

    await pool.testInitializePool("test-query", configWithLibs, TEST_CONTEXT);

    const result = await pool.testExecuteQuery("test-query", "SELECT 1");
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ result: 1 }]);
  });

  it("4.5 – library list preserved through pool re-initialization after timeout", async () => {
    config.poolTimeouts.queryTimeoutMs = 1_000;
    pool = new TestConnectionPool();
    const configWithLibs: PoolConnectionConfig = {
      ...BASE_CONFIG,
      libraryList: ["MYLIB", "DEVDATA"],
    };

    await pool.testInitializePool("test-reinit", configWithLibs, TEST_CONTEXT);

    // First call: trigger timeout
    mockPoolInstance.execute.mockReturnValueOnce(new Promise(() => {}));
    const queryPromise = pool.testExecuteQuery("test-reinit", "SELECT SLOW()");
    const assertion = expect(queryPromise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;

    // Reset execute to succeed
    mockPoolInstance.execute.mockResolvedValue(SUCCESSFUL_RESULT);

    // Second call: should re-init with same library list
    await pool.testExecuteQuery("test-reinit", "SELECT 1");

    expect(MockPool).toHaveBeenCalledTimes(2);
    // Both calls should have the libraries option
    expect(MockPool.mock.calls[0][0].opts.libraries).toEqual(["MYLIB", "DEVDATA"]);
    expect(MockPool.mock.calls[1][0].opts.libraries).toEqual(["MYLIB", "DEVDATA"]);
  });

  it("4.6 – creds, maxSize, startingSize are still passed correctly with library list", async () => {
    pool = new TestConnectionPool();
    const configWithLibs: PoolConnectionConfig = {
      ...BASE_CONFIG,
      libraryList: ["LIB1"],
      maxSize: 20,
      startingSize: 5,
    };

    await pool.testInitializePool("test-full", configWithLibs, TEST_CONTEXT);

    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.creds.host).toBe("test-host");
    expect(poolArgs.creds.user).toBe("testuser");
    expect(poolArgs.maxSize).toBe(20);
    expect(poolArgs.startingSize).toBe(5);
    expect(poolArgs.opts.libraries).toEqual(["LIB1"]);
  });
});

// ═══════════════════════════════════════════════════════════���═══════════════
// Group 5 – SourceManager library list wiring
// ═══════════════════════════════��═════════════════════════════════════��═════
describe("SourceManager – library list wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();
    config.poolTimeouts.queryTimeoutMs = 0;
    config.poolTimeouts.idleTimeoutMs = 0;
  });

  afterEach(async () => {
    await BaseConnectionPool.shutdownAll();
    restoreConfig();
    vi.useRealTimers();
  });

  it("5.1 – registerSource stores libraryList in pool config from array", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("dev", {
      host: "dev400",
      user: "devuser",
      password: "devpass",
      port: 8076,
      "library-list": ["DEVLIB", "DEVDATA"],
    });

    const poolState = sm.getPoolsMap().get("dev");
    expect(poolState).toBeDefined();
    expect(poolState!.config.libraryList).toEqual(["DEVLIB", "DEVDATA"]);
  });

  it("5.2 – registerSource works without library-list", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("prod", {
      host: "prod400",
      user: "produser",
      password: "prodpass",
      port: 8076,
    });

    const poolState = sm.getPoolsMap().get("prod");
    expect(poolState).toBeDefined();
    expect(poolState!.config.libraryList).toBeUndefined();
  });

  it("5.3 – different sources can have different library lists", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("dev", {
      host: "dev400",
      user: "u",
      password: "p",
      "library-list": ["DEVLIB"],
    });
    await sm.registerSource("staging", {
      host: "stg400",
      user: "u",
      password: "p",
      "library-list": ["STGLIB", "STGDATA"],
    });
    await sm.registerSource("prod", {
      host: "prod400",
      user: "u",
      password: "p",
    });

    expect(sm.getPoolsMap().get("dev")!.config.libraryList).toEqual(["DEVLIB"]);
    expect(sm.getPoolsMap().get("staging")!.config.libraryList).toEqual([
      "STGLIB",
      "STGDATA",
    ]);
    expect(sm.getPoolsMap().get("prod")!.config.libraryList).toBeUndefined();
  });

  it("5.4 – library list flows through to mapepire Pool on first query", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("dev", {
      host: "dev400",
      user: "devuser",
      password: "devpass",
      "library-list": ["DEVLIB", "DEVDATA"],
    });

    // Execute a query to trigger lazy initialization
    await sm.executeQuery("dev", "SELECT 1 FROM SYSIBM.SYSDUMMY1");

    expect(MockPool).toHaveBeenCalledTimes(1);
    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toBeDefined();
    expect(poolArgs.opts.libraries).toEqual(["DEVLIB", "DEVDATA"]);
  });

  it("5.5 – source without library-list does not pass opts to Pool", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("plain", {
      host: "plain400",
      user: "user",
      password: "pass",
    });

    await sm.executeQuery("plain", "SELECT 1 FROM SYSIBM.SYSDUMMY1");

    expect(MockPool).toHaveBeenCalledTimes(1);
    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toBeUndefined();
  });
});
