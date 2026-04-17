/**
 * @fileoverview Tests for jdbc-options configuration across all layers
 * Covers: DB2i_JDBC_OPTIONS env var parsing, YAML schema validation,
 * PoolConnectionConfig wiring, mapepire Pool JDBC options, SourceManager
 * registration (with env-over-YAML merge), and IBMiConnectionPool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PoolConnectionConfig } from "../../../src/ibmi-mcp-server/services/baseConnectionPool.js";

// ---------------------------------------------------------------------------
// Hoisted mock state – vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------
const { mockPoolInstance, mockQueryInstance, MockPool, mockGetRootCert } =
  vi.hoisted(() => {
    // executeQuery now routes through pool.query().execute().close() (PR #139),
    // so the query object is the primary execution surface.
    const mockQueryInstance = {
      execute: vi.fn(),
      fetchMore: vi.fn(),
      close: vi.fn(),
    };
    const mockPoolInstance = {
      init: vi.fn(),
      execute: vi.fn(),
      end: vi.fn(),
      query: vi.fn(() => mockQueryInstance),
    };
    return {
      mockPoolInstance,
      mockQueryInstance,
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
import { logger } from "../../../src/utils/internal/index.js";

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
  requestId: "jdbc-options-test",
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
  // executeQuery flows through pool.query().execute().close(); re-wire the
  // query factory each run so test-local mockImplementation overrides reset.
  mockPoolInstance.query
    .mockReset()
    .mockImplementation(() => mockQueryInstance);
  mockQueryInstance.execute.mockReset().mockResolvedValue(SUCCESSFUL_RESULT);
  mockQueryInstance.fetchMore
    .mockReset()
    .mockResolvedValue({ success: true, data: [], is_done: true });
  mockQueryInstance.close.mockReset().mockResolvedValue(undefined);
  mockGetRootCert.mockClear();
}

function restoreConfig() {
  config.poolTimeouts.idleTimeoutMs = ORIGINAL_IDLE_TIMEOUT;
  config.poolTimeouts.queryTimeoutMs = ORIGINAL_QUERY_TIMEOUT;
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 1 – SourceConfigSchema jdbc-options validation
// ═══════════════════════════════════════════════════════════════════════════
describe("SourceConfigSchema – jdbc-options field", () => {
  const base = { host: "myhost", user: "myuser", password: "mypass" };

  it("1.1 – accepts libraries as an array of names", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "jdbc-options": { libraries: ["MYLIB", "DEVDATA", "QGPL"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["jdbc-options"]?.libraries).toEqual([
        "MYLIB",
        "DEVDATA",
        "QGPL",
      ]);
    }
  });

  it("1.2 – accepts libraries as comma-separated string and transforms to array", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "jdbc-options": { libraries: "MYLIB, DEVDATA, QGPL" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["jdbc-options"]?.libraries).toEqual([
        "MYLIB",
        "DEVDATA",
        "QGPL",
      ]);
    }
  });

  it("1.3 – accepts a single library as string", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "jdbc-options": { libraries: "MYLIB" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["jdbc-options"]?.libraries).toEqual(["MYLIB"]);
    }
  });

  it("1.4 – jdbc-options is optional (omitting it succeeds)", () => {
    const result = SourceConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["jdbc-options"]).toBeUndefined();
    }
  });

  it("1.5 – rejects empty strings in libraries array", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "jdbc-options": { libraries: ["MYLIB", ""] },
    });
    expect(result.success).toBe(false);
  });

  it("1.6 – libraries comma-separated string handles extra whitespace", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "jdbc-options": { libraries: "  MYLIB ,  DEVDATA  ,  QGPL  " },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["jdbc-options"]?.libraries).toEqual([
        "MYLIB",
        "DEVDATA",
        "QGPL",
      ]);
    }
  });

  it("1.7 – filters empty entries from libraries comma-separated string", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "jdbc-options": { libraries: "MYLIB,,DEVDATA," },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["jdbc-options"]?.libraries).toEqual([
        "MYLIB",
        "DEVDATA",
      ]);
    }
  });

  it("1.8 – empty libraries string results in empty array", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "jdbc-options": { libraries: "" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["jdbc-options"]?.libraries).toEqual([]);
    }
  });

  it("1.9 – accepts non-libraries JDBC options (naming, date format)", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "jdbc-options": { naming: "system", "date format": "iso" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["jdbc-options"]).toEqual({
        naming: "system",
        "date format": "iso",
      });
    }
  });

  it("1.10 – accepts libraries combined with other JDBC options", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "jdbc-options": {
        libraries: ["MYLIB", "DEVDATA"],
        naming: "system",
        "date format": "iso",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["jdbc-options"]?.libraries).toEqual([
        "MYLIB",
        "DEVDATA",
      ]);
      expect(result.data["jdbc-options"]).toMatchObject({
        naming: "system",
        "date format": "iso",
      });
    }
  });

  it("1.11 – empty jdbc-options object parses successfully", () => {
    const result = SourceConfigSchema.safeParse({
      ...base,
      "jdbc-options": {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["jdbc-options"]).toEqual({});
    }
  });

  it("1.12 – passthrough: unknown keys (typos) pass validation", () => {
    // Documents the intentional tradeoff of `.passthrough()`: typos like
    // `librarys` silently flow through. Exhaustive enum would couple the
    // schema to mapepire's 60+ JDBCOption keys and break on upstream additions.
    const result = SourceConfigSchema.safeParse({
      ...base,
      "jdbc-options": { librarys: ["MYLIB"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // The typo is preserved in the parsed output (forwarded to mapepire as-is)
      expect(
        (result.data["jdbc-options"] as Record<string, unknown>).librarys,
      ).toEqual(["MYLIB"]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 2 – SqlToolsConfigSchema with jdbc-options in sources
// ═══════════════════════════════════════════════════════════════════════════
describe("SqlToolsConfigSchema – jdbc-options in YAML sources", () => {
  it("2.1 – full YAML config with jdbc-options parses correctly", () => {
    const result = SqlToolsConfigSchema.safeParse({
      sources: {
        "dev-system": {
          host: "dev400.example.com",
          user: "DEVUSER",
          password: "devpass",
          port: 8076,
          "jdbc-options": {
            libraries: ["DEVLIB", "DEVDATA", "QGPL"],
          },
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
      expect(
        result.data.sources!["dev-system"]["jdbc-options"]?.libraries,
      ).toEqual(["DEVLIB", "DEVDATA", "QGPL"]);
    }
  });

  it("2.2 – YAML config without jdbc-options still parses", () => {
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

// ═══════════════════════════════════════════════════════════════════════════
// Group 3 – DB2i_JDBC_OPTIONS env var parser
// ═══════════════════════════════════════════════════════════════════════════
describe("config.db2i – DB2i_JDBC_OPTIONS env var parser", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function setCreds() {
    process.env.DB2i_HOST = "testhost";
    process.env.DB2i_USER = "testuser";
    process.env.DB2i_PASS = "testpass";
  }

  it("3.1 – parses simple key=value pairs (naming, date format)", () => {
    setCreds();
    process.env.DB2i_JDBC_OPTIONS = "naming=system;date format=iso";

    expect(config.db2i!.jdbcOptions).toEqual({
      naming: "system",
      "date format": "iso",
    });
  });

  it("3.2 – parses libraries as comma-separated array within one value", () => {
    setCreds();
    process.env.DB2i_JDBC_OPTIONS = "libraries=A,B,C";

    expect(config.db2i!.jdbcOptions).toEqual({
      libraries: ["A", "B", "C"],
    });
  });

  it("3.3 – combined options forward booleans as strings (no coercion)", () => {
    setCreds();
    process.env.DB2i_JDBC_OPTIONS =
      "naming=system;libraries=A,B;full open=true";

    const jdbcOptions = config.db2i!.jdbcOptions as Record<string, unknown>;
    expect(jdbcOptions.naming).toBe("system");
    expect(jdbcOptions.libraries).toEqual(["A", "B"]);
    // "full open=true" stays as the string "true", NOT boolean true — the JDBC
    // driver is string-based underneath; no bool coercion in the parser.
    expect(jdbcOptions["full open"]).toBe("true");
    expect(jdbcOptions["full open"]).not.toBe(true);
  });

  it("3.4 – trims whitespace around keys, values, and within libraries list", () => {
    setCreds();
    process.env.DB2i_JDBC_OPTIONS =
      " naming = system ; libraries = A , B ";

    expect(config.db2i!.jdbcOptions).toEqual({
      naming: "system",
      libraries: ["A", "B"],
    });
  });

  it("3.5 – ignores empty segments (double semicolons, leading/trailing)", () => {
    setCreds();
    process.env.DB2i_JDBC_OPTIONS =
      ";naming=system;;date format=iso;";

    expect(config.db2i!.jdbcOptions).toEqual({
      naming: "system",
      "date format": "iso",
    });
  });

  it("3.6 – throws on malformed pair (no `=`)", () => {
    setCreds();
    process.env.DB2i_JDBC_OPTIONS = "naming=system;broken";

    expect(() => config.db2i).toThrow(/malformed pair/i);
  });

  it("3.7 – throws on empty key", () => {
    setCreds();
    process.env.DB2i_JDBC_OPTIONS = "=value;naming=system";

    expect(() => config.db2i).toThrow(/empty key/i);
  });

  it("3.8 – omits jdbcOptions when env var is not set", () => {
    setCreds();
    delete process.env.DB2i_JDBC_OPTIONS;

    const db2i = config.db2i;
    expect(db2i).toBeDefined();
    expect(db2i!.jdbcOptions).toBeUndefined();
  });

  it("3.9 – omits jdbcOptions when env var is empty string", () => {
    setCreds();
    process.env.DB2i_JDBC_OPTIONS = "";

    expect(config.db2i!.jdbcOptions).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 4 – BaseConnectionPool passes JDBC opts to mapepire Pool
// ═══════════════════════════════════════════════════════════════════════════
describe("BaseConnectionPool – jdbcOptions JDBC wiring", () => {
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

  it("4.1 – passes libraries in opts when jdbcOptions.libraries is configured", async () => {
    pool = new TestConnectionPool();
    const configWithLibs: PoolConnectionConfig = {
      ...BASE_CONFIG,
      jdbcOptions: { libraries: ["MYLIB", "DEVDATA", "QGPL"] },
    };

    await pool.testInitializePool("test-libs", configWithLibs, TEST_CONTEXT);

    expect(MockPool).toHaveBeenCalledTimes(1);
    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toBeDefined();
    expect(poolArgs.opts.libraries).toEqual(["MYLIB", "DEVDATA", "QGPL"]);
  });

  it("4.2 – does not pass opts when jdbcOptions is undefined", async () => {
    pool = new TestConnectionPool();
    await pool.testInitializePool("test-no-libs", BASE_CONFIG, TEST_CONTEXT);

    expect(MockPool).toHaveBeenCalledTimes(1);
    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toBeUndefined();
  });

  it("4.3 – does not pass opts when jdbcOptions is empty object {}", async () => {
    pool = new TestConnectionPool();
    const configWithEmpty: PoolConnectionConfig = {
      ...BASE_CONFIG,
      jdbcOptions: {},
    };

    await pool.testInitializePool("test-empty", configWithEmpty, TEST_CONTEXT);

    expect(MockPool).toHaveBeenCalledTimes(1);
    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toBeUndefined();
  });

  it("4.4 – pool still initializes and executes queries with jdbc-options", async () => {
    pool = new TestConnectionPool();
    const configWithLibs: PoolConnectionConfig = {
      ...BASE_CONFIG,
      jdbcOptions: { libraries: ["MYLIB"] },
    };

    await pool.testInitializePool("test-query", configWithLibs, TEST_CONTEXT);

    const result = await pool.testExecuteQuery("test-query", "SELECT 1");
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ result: 1 }]);
  });

  it("4.5 – jdbcOptions preserved through pool re-initialization after timeout", async () => {
    config.poolTimeouts.queryTimeoutMs = 1_000;
    pool = new TestConnectionPool();
    const configWithLibs: PoolConnectionConfig = {
      ...BASE_CONFIG,
      jdbcOptions: { libraries: ["MYLIB", "DEVDATA"] },
    };

    await pool.testInitializePool("test-reinit", configWithLibs, TEST_CONTEXT);

    // First call: trigger timeout on the Query.execute() path (PR #139)
    mockQueryInstance.execute.mockReturnValueOnce(new Promise(() => {}));
    const queryPromise = pool.testExecuteQuery("test-reinit", "SELECT SLOW()");
    const assertion = expect(queryPromise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;

    // Reset execute to succeed
    mockQueryInstance.execute.mockResolvedValue(SUCCESSFUL_RESULT);

    // Second call: should re-init with same jdbcOptions
    await pool.testExecuteQuery("test-reinit", "SELECT 1");

    expect(MockPool).toHaveBeenCalledTimes(2);
    expect(MockPool.mock.calls[0][0].opts.libraries).toEqual([
      "MYLIB",
      "DEVDATA",
    ]);
    expect(MockPool.mock.calls[1][0].opts.libraries).toEqual([
      "MYLIB",
      "DEVDATA",
    ]);
  });

  it("4.6 – creds, maxSize, startingSize are still passed correctly with jdbcOptions", async () => {
    pool = new TestConnectionPool();
    const configWithLibs: PoolConnectionConfig = {
      ...BASE_CONFIG,
      jdbcOptions: { libraries: ["LIB1"] },
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

  it("4.7 – passes non-libraries JDBC options (e.g., naming) to Pool opts", async () => {
    pool = new TestConnectionPool();
    const cfg: PoolConnectionConfig = {
      ...BASE_CONFIG,
      jdbcOptions: { naming: "system", "date format": "iso" },
    };

    await pool.testInitializePool("test-naming", cfg, TEST_CONTEXT);

    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toEqual({
      naming: "system",
      "date format": "iso",
    });
  });

  it("4.8 – passes combined libraries + other JDBC options to Pool opts", async () => {
    pool = new TestConnectionPool();
    const cfg: PoolConnectionConfig = {
      ...BASE_CONFIG,
      jdbcOptions: {
        libraries: ["MYLIB"],
        naming: "system",
        "date format": "iso",
      },
    };

    await pool.testInitializePool("test-combo", cfg, TEST_CONTEXT);

    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts.libraries).toEqual(["MYLIB"]);
    expect(poolArgs.opts.naming).toBe("system");
    expect(poolArgs.opts["date format"]).toBe("iso");
  });

  it("4.9 – does NOT pass opts when jdbcOptions is empty object {} (duplicate of 4.3 for plan-table parity)", async () => {
    pool = new TestConnectionPool();
    const cfg: PoolConnectionConfig = {
      ...BASE_CONFIG,
      jdbcOptions: {},
    };

    await pool.testInitializePool("test-empty-2", cfg, TEST_CONTEXT);

    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toBeUndefined();
  });

  it("4.10 – logs only libraries, not full jdbcOptions (no `key ring password`)", async () => {
    const logSpy = vi.spyOn(logger, "info");
    pool = new TestConnectionPool();
    const cfg: PoolConnectionConfig = {
      ...BASE_CONFIG,
      jdbcOptions: {
        libraries: ["MYLIB"],
        "key ring password": "s3cret",
        naming: "system",
      } as PoolConnectionConfig["jdbcOptions"],
    };

    await pool.testInitializePool("test-log-redact", cfg, TEST_CONTEXT);

    // Find the pool-init log call
    const initCall = logSpy.mock.calls.find(
      (c) =>
        typeof c[1] === "string" &&
        c[1].includes("Initializing connection pool"),
    );
    expect(initCall).toBeDefined();
    const logPayload = JSON.stringify(initCall![0]);
    expect(logPayload).toContain("libraries");
    expect(logPayload).not.toContain("key ring password");
    expect(logPayload).not.toContain("s3cret");
    // Ensure non-sensitive non-libraries fields are also NOT logged (the log
    // contract is "libraries only", not "libraries + safe-looking fields")
    expect(logPayload).not.toContain("naming");

    logSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 5 – SourceManager jdbc-options wiring (YAML base, env override)
// ═══════════════════════════════════════════════════════════════════════════
describe("SourceManager – jdbc-options wiring", () => {
  const originalEnv = { ...process.env };

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
    process.env = { ...originalEnv };
  });

  it("5.1 – registerSource stores libraries in pool config from array", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("dev", {
      host: "dev400",
      user: "devuser",
      password: "devpass",
      port: 8076,
      "jdbc-options": { libraries: ["DEVLIB", "DEVDATA"] },
    });

    const poolState = sm.getPoolsMap().get("dev");
    expect(poolState).toBeDefined();
    expect(poolState!.config.jdbcOptions?.libraries).toEqual([
      "DEVLIB",
      "DEVDATA",
    ]);
  });

  it("5.2 – registerSource works without jdbc-options", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("prod", {
      host: "prod400",
      user: "produser",
      password: "prodpass",
      port: 8076,
    });

    const poolState = sm.getPoolsMap().get("prod");
    expect(poolState).toBeDefined();
    expect(poolState!.config.jdbcOptions).toBeUndefined();
  });

  it("5.3 – different sources can have different jdbc-options", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("dev", {
      host: "dev400",
      user: "u",
      password: "p",
      "jdbc-options": { libraries: ["DEVLIB"] },
    });
    await sm.registerSource("staging", {
      host: "stg400",
      user: "u",
      password: "p",
      "jdbc-options": { libraries: ["STGLIB", "STGDATA"] },
    });
    await sm.registerSource("prod", {
      host: "prod400",
      user: "u",
      password: "p",
    });

    expect(
      sm.getPoolsMap().get("dev")!.config.jdbcOptions?.libraries,
    ).toEqual(["DEVLIB"]);
    expect(
      sm.getPoolsMap().get("staging")!.config.jdbcOptions?.libraries,
    ).toEqual(["STGLIB", "STGDATA"]);
    expect(sm.getPoolsMap().get("prod")!.config.jdbcOptions).toBeUndefined();
  });

  it("5.4 – jdbc-options flows through to mapepire Pool on first query", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("dev", {
      host: "dev400",
      user: "devuser",
      password: "devpass",
      "jdbc-options": { libraries: ["DEVLIB", "DEVDATA"] },
    });

    await sm.executeQuery("dev", "SELECT 1 FROM SYSIBM.SYSDUMMY1");

    expect(MockPool).toHaveBeenCalledTimes(1);
    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toBeDefined();
    expect(poolArgs.opts.libraries).toEqual(["DEVLIB", "DEVDATA"]);
  });

  it("5.5 – source without jdbc-options does not pass opts to Pool", async () => {
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

  it("5.6 – non-libraries JDBC options flow through on first query", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("dev", {
      host: "dev400",
      user: "u",
      password: "p",
      "jdbc-options": { naming: "system", "date format": "iso" },
    });

    await sm.executeQuery("dev", "SELECT 1 FROM SYSIBM.SYSDUMMY1");

    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toEqual({
      naming: "system",
      "date format": "iso",
    });
  });

  it("5.7 – env jdbcOptions overrides YAML jdbc-options (merge, env wins)", async () => {
    // Env sets naming=system and libraries=ENVLIB; YAML sets naming=sql and libraries=YAMLLIB.
    // Env should win on both keys.
    process.env.DB2i_HOST = "envhost";
    process.env.DB2i_USER = "envuser";
    process.env.DB2i_PASS = "envpass";
    process.env.DB2i_JDBC_OPTIONS = "naming=system;libraries=ENVLIB";

    const sm = new TestSourceManager();
    await sm.registerSource("dev", {
      host: "dev400",
      user: "u",
      password: "p",
      "jdbc-options": {
        naming: "sql",
        libraries: ["YAMLLIB"],
        "date format": "iso",
      },
    });

    const poolState = sm.getPoolsMap().get("dev");
    expect(poolState!.config.jdbcOptions).toEqual({
      naming: "system",
      libraries: ["ENVLIB"],
      "date format": "iso", // from YAML, not overridden by env
    });
  });

  it("5.8 – YAML jdbc-options alone (no env) reaches Pool unchanged", async () => {
    delete process.env.DB2i_JDBC_OPTIONS;

    const sm = new TestSourceManager();
    await sm.registerSource("dev", {
      host: "dev400",
      user: "u",
      password: "p",
      "jdbc-options": {
        libraries: ["YAMLLIB"],
        naming: "sql",
      },
    });

    await sm.executeQuery("dev", "SELECT 1 FROM SYSIBM.SYSDUMMY1");

    const poolArgs = MockPool.mock.calls[0][0];
    expect(poolArgs.opts).toEqual({
      libraries: ["YAMLLIB"],
      naming: "sql",
    });
  });
});
