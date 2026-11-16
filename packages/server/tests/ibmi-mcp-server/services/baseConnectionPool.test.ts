/**
 * @fileoverview Tests for BaseConnectionPool timeout, idle, and shutdown features
 * Covers query timeout, idle pool closure, static instance registry, and SourceManager health.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PoolConnectionConfig } from "../../../src/ibmi-mcp-server/services/baseConnectionPool.js";

// ---------------------------------------------------------------------------
// Hoisted mock state – vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------
const { mockPoolInstance, mockQueryInstance, MockPool, mockGetRootCert } =
  vi.hoisted(() => {
    // executeQuery now routes through pool.query().execute().close(), so the
    // query object is the primary mock surface. executeQueryWithPagination
    // also uses fetchMore(). Defaults are set in resetMocks().
    const mockQueryInstance = {
      execute: vi.fn(),
      fetchMore: vi.fn(),
      close: vi.fn(),
    };
    const query = vi.fn(() => mockQueryInstance);
    const mockPoolInstance = {
      init: vi.fn(),
      execute: vi.fn(),
      end: vi.fn(),
      query,
      // The pool picks one of these connections for each statement: one
      // ready job, which starts every statement through `query`.
      jobs: [{ getStatus: () => "ready", query }],
    };
    return {
      mockPoolInstance,
      mockQueryInstance,
      MockPool: vi.fn(function () {
        return mockPoolInstance;
      }),
      mockGetRootCert: vi.fn().mockResolvedValue("cert"),
    };
  });

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

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
  config,
  DEFAULT_PAGE_SIZE,
  MAX_PAGINATION_ROWS,
} from "../../../src/config/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Concrete subclass that exposes protected members for testing */
class TestConnectionPool extends BaseConnectionPool<string> {
  async testExecuteQuery(
    poolId: string,
    query: string,
    params?: unknown[],
    context?: Record<string, unknown>,
  ) {
    return this.executeQuery(poolId, query, params as never, context as never);
  }

  async testExecuteQueryWithPagination(poolId: string, query: string) {
    return this.executeQueryWithPagination(
      poolId,
      query,
      undefined,
      TEST_CONTEXT as never,
    );
  }

  async testInitializePool(
    poolId: string,
    poolConfig: PoolConnectionConfig,
    context: Record<string, unknown>,
  ) {
    return this.initializePool(poolId, poolConfig, context as never);
  }

  testStartIdleTimer() {
    this.startIdleTimer();
  }

  getPoolsMap() {
    return this.pools;
  }
}

/** Subclass of SourceManager that exposes the internal pools map */
class TestSourceManager extends SourceManager {
  getPoolsMap() {
    return this.pools;
  }
}

const TEST_CONFIG: PoolConnectionConfig = {
  host: "test-host",
  user: "testuser",
  password: "testpass",
  port: 8076,
  ignoreUnauthorized: true,
};

const TEST_CONTEXT = {
  requestId: "test-req-001",
  timestamp: new Date().toISOString(),
  operation: "Test",
};

const SUCCESSFUL_RESULT = {
  success: true,
  data: [{ result: 1 }],
  sql_rc: 0,
  execution_time: 50,
};

/** Original config values, saved/restored around tests */
const ORIGINAL_IDLE_TIMEOUT = config.poolTimeouts.idleTimeoutMs;
const ORIGINAL_QUERY_TIMEOUT = config.poolTimeouts.queryTimeoutMs;

/** Reset all mock functions to sensible defaults */
function resetMocks() {
  MockPool.mockClear();
  mockPoolInstance.init.mockReset().mockResolvedValue(undefined);
  mockPoolInstance.execute.mockReset().mockResolvedValue(SUCCESSFUL_RESULT);
  mockPoolInstance.end.mockReset().mockResolvedValue(undefined);
  // executeQuery uses pool.query().execute().close(); the pagination path
  // uses pool.query().execute() + fetchMore() + close(). Reset and re-wire
  // the query factory each run so mockImplementation in one test doesn't
  // leak into the next.
  mockPoolInstance.query
    .mockReset()
    .mockImplementation(() => mockQueryInstance);
  mockQueryInstance.execute.mockReset().mockResolvedValue(SUCCESSFUL_RESULT);
  mockQueryInstance.fetchMore
    .mockReset()
    .mockResolvedValue({ ...SUCCESSFUL_RESULT, is_done: true, data: [] });
  mockQueryInstance.close.mockReset().mockResolvedValue(undefined);
  mockGetRootCert.mockClear();
}

/** Restore config to original values */
function restoreConfig() {
  config.poolTimeouts.idleTimeoutMs = ORIGINAL_IDLE_TIMEOUT;
  config.poolTimeouts.queryTimeoutMs = ORIGINAL_QUERY_TIMEOUT;
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 1 – Query Timeout
// ═══════════════════════════════════════════════════════════════════════════
describe("BaseConnectionPool – Query Timeout", () => {
  let pool: TestConnectionPool;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetMocks();
    config.poolTimeouts.queryTimeoutMs = 1_000;
    config.poolTimeouts.idleTimeoutMs = 0; // disable idle timer in timeout tests

    pool = new TestConnectionPool();
    await pool.testInitializePool("test", TEST_CONFIG, TEST_CONTEXT);
  });

  afterEach(async () => {
    await BaseConnectionPool.shutdownAll();
    restoreConfig();
    vi.useRealTimers();
  });

  it("1.1 – returns result when query completes before timeout", async () => {
    const result = await pool.testExecuteQuery("test", "SELECT 1");

    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ result: 1 }]);

    const state = pool.getPoolsMap().get("test")!;
    expect(state.healthStatus).toBe("healthy");
    expect(state.lastActivityAt).toBeInstanceOf(Date);
  });

  it("1.2 – throws with 'timed out' when query exceeds timeout", async () => {
    // execute never resolves → timeout will fire
    mockQueryInstance.execute.mockReturnValue(new Promise(() => {}));

    const queryPromise = pool.testExecuteQuery("test", "SELECT SLOW()");
    // Attach assertion BEFORE advancing timers to prevent unhandled rejection
    const assertion = expect(queryPromise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;

    // The timeout closes the pool: it is nulled out and reads unhealthy
    // until the next request re-initializes it.
    const state = pool.getPoolsMap().get("test")!;
    expect(state.pool).toBeNull();
    expect(state.isInitialized).toBe(false);
    expect(state.healthStatus).toBe("unhealthy");

    // pool.end() should have been called to close the timed-out pool
    expect(mockPoolInstance.end).toHaveBeenCalled();
  });

  it("1.3 – queryTimeoutMs=0 disables timeout (slow query succeeds)", async () => {
    config.poolTimeouts.queryTimeoutMs = 0;

    // execute resolves normally (timeout disabled, so no race)
    const result = await pool.testExecuteQuery("test", "SELECT SLOW()");

    expect(result.success).toBe(true);
  });

  it("1.4 – non-timeout errors propagate with original message", async () => {
    mockQueryInstance.execute.mockRejectedValue(
      new Error("SQLSTATE=42S02 Table not found"),
    );

    await expect(
      pool.testExecuteQuery("test", "SELECT * FROM NOPE"),
    ).rejects.toThrow(/Table not found/);
  });

  it("1.5 – timeout timer is cleared on success (no leak)", async () => {
    // Query completes immediately
    const result = await pool.testExecuteQuery("test", "SELECT 1");
    expect(result.success).toBe(true);

    // Advance well past the timeout — nothing should blow up or change status
    await vi.advanceTimersByTimeAsync(5_000);

    const state = pool.getPoolsMap().get("test")!;
    expect(state.healthStatus).toBe("healthy");
  });

  it("1.6 – pool re-initializes transparently after timeout closure", async () => {
    // First call: hangs → triggers timeout
    mockQueryInstance.execute.mockReturnValueOnce(new Promise(() => {}));

    const firstCall = pool.testExecuteQuery("test", "SELECT SLOW()");
    const assertion = expect(firstCall).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;

    // Reset execute to succeed for the next call
    mockQueryInstance.execute.mockResolvedValue(SUCCESSFUL_RESULT);

    // Second call should trigger re-init and succeed
    const secondResult = await pool.testExecuteQuery("test", "SELECT 1");
    expect(secondResult.success).toBe(true);

    // Pool constructor should have been called twice (init + re-init), each
    // time opening a probe connection and then the remaining ones
    expect(MockPool).toHaveBeenCalledTimes(2);
    expect(mockPoolInstance.init).toHaveBeenCalledTimes(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 2 – Idle Timer
// ═══════════════════════════════════════════════════════════════════════════
describe("BaseConnectionPool – Idle Timer", () => {
  let pool: TestConnectionPool;

  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();
    config.poolTimeouts.queryTimeoutMs = 0; // disable query timeout in idle tests
  });

  afterEach(async () => {
    await BaseConnectionPool.shutdownAll();
    restoreConfig();
    vi.useRealTimers();
  });

  it("2.1 – idle timer starts and eventually closes idle pool", async () => {
    config.poolTimeouts.idleTimeoutMs = 20_000; // 20s → check interval = max(10s, 10s) = 10s
    pool = new TestConnectionPool();
    await pool.testInitializePool("test", TEST_CONFIG, TEST_CONTEXT);

    const state = pool.getPoolsMap().get("test")!;
    expect(state.isInitialized).toBe(true);

    // Advance past idle timeout + check interval to trigger closure
    // At 10s: idle=10s < 20s → skip. At 20s: idle=20s, not > 20s → skip.
    // At 30s: idle=30s > 20s → close!
    await vi.advanceTimersByTimeAsync(30_001);

    expect(state.isInitialized).toBe(false);
    expect(state.pool).toBeNull();
    expect(mockPoolInstance.end).toHaveBeenCalled();
  });

  it("2.2 – calling startIdleTimer twice is idempotent", async () => {
    config.poolTimeouts.idleTimeoutMs = 20_000;
    pool = new TestConnectionPool();
    await pool.testInitializePool("test", TEST_CONFIG, TEST_CONTEXT);

    // startIdleTimer was already called during init; call again explicitly
    pool.testStartIdleTimer();

    // Advance to trigger one idle close
    await vi.advanceTimersByTimeAsync(30_001);

    // end() should be called exactly once (not twice from duplicate intervals)
    expect(mockPoolInstance.end).toHaveBeenCalledTimes(1);
  });

  it("2.3 – idleTimeoutMs=0 prevents idle timer from starting", async () => {
    config.poolTimeouts.idleTimeoutMs = 0;
    pool = new TestConnectionPool();
    await pool.testInitializePool("test", TEST_CONFIG, TEST_CONTEXT);

    // Advance a long time — nothing should close
    await vi.advanceTimersByTimeAsync(600_000);

    const state = pool.getPoolsMap().get("test")!;
    expect(state.isInitialized).toBe(true);
    expect(mockPoolInstance.end).not.toHaveBeenCalled();
  });

  it("2.4 – closes a pool that exceeds idle timeout, re-inits on next use", async () => {
    config.poolTimeouts.idleTimeoutMs = 20_000;
    pool = new TestConnectionPool();
    await pool.testInitializePool("test", TEST_CONFIG, TEST_CONTEXT);

    // Let the pool go idle and get closed
    await vi.advanceTimersByTimeAsync(30_001);

    const state = pool.getPoolsMap().get("test")!;
    expect(state.isInitialized).toBe(false);

    // Next query should re-init transparently
    const result = await pool.testExecuteQuery("test", "SELECT 1");
    expect(result.success).toBe(true);
    expect(MockPool).toHaveBeenCalledTimes(2);
  });

  it("2.5 – does NOT close a pool with recent activity", async () => {
    config.poolTimeouts.idleTimeoutMs = 30_000; // check interval = 15s
    pool = new TestConnectionPool();
    await pool.testInitializePool("test", TEST_CONFIG, TEST_CONTEXT);

    // Advance 25s (close to timeout but not past it)
    await vi.advanceTimersByTimeAsync(25_000);

    // Execute a query to refresh lastActivityAt
    await pool.testExecuteQuery("test", "SELECT 1");

    // Advance another 20s (total 45s from start, but only 20s from last activity)
    await vi.advanceTimersByTimeAsync(20_000);

    const state = pool.getPoolsMap().get("test")!;
    expect(state.isInitialized).toBe(true);
    expect(mockPoolInstance.end).not.toHaveBeenCalled();
  });

  it("2.6 – stopIdleTimer prevents further idle closures", async () => {
    config.poolTimeouts.idleTimeoutMs = 20_000;
    pool = new TestConnectionPool();
    await pool.testInitializePool("test", TEST_CONFIG, TEST_CONTEXT);

    // Stop the timer before any check fires
    pool.stopIdleTimer();

    // Advance well past timeout
    await vi.advanceTimersByTimeAsync(60_000);

    const state = pool.getPoolsMap().get("test")!;
    expect(state.isInitialized).toBe(true);
    expect(mockPoolInstance.end).not.toHaveBeenCalled();
  });

  it("2.7 – check interval = max(10s, timeout/2)", async () => {
    // Case A: 60s timeout → interval should be 30s (60/2 > 10)
    config.poolTimeouts.idleTimeoutMs = 60_000;
    const pool60 = new TestConnectionPool();
    await pool60.testInitializePool("test60", TEST_CONFIG, TEST_CONTEXT);

    // At 30s: idle=30s < 60s → no close. At 60s: idle=60s, not > 60s → no close.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(pool60.getPoolsMap().get("test60")!.isInitialized).toBe(true);

    // At 90s: idle=90s > 60s → close!
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pool60.getPoolsMap().get("test60")!.isInitialized).toBe(false);

    // Case B: 15s timeout → interval should be 10s (floor(15/2)=7 < 10 → 10)
    // Need a fresh pool for this test
    await BaseConnectionPool.shutdownAll();
    resetMocks();
    config.poolTimeouts.idleTimeoutMs = 15_000;
    const pool15 = new TestConnectionPool();
    await pool15.testInitializePool("test15", TEST_CONFIG, TEST_CONTEXT);

    // At 10s: idle=10s < 15s → no close. At 20s: idle=20s > 15s → close!
    await vi.advanceTimersByTimeAsync(20_001);
    expect(pool15.getPoolsMap().get("test15")!.isInitialized).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 3 – Static Instance Registry & Shutdown
// ═══════════════════════════════════════════════════════════════════════════
describe("BaseConnectionPool – Static Instance Registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();
    config.poolTimeouts.queryTimeoutMs = 0;
    config.poolTimeouts.idleTimeoutMs = 0;
  });

  afterEach(async () => {
    // Final cleanup (some tests may have already called shutdownAll)
    await BaseConnectionPool.shutdownAll();
    restoreConfig();
    vi.useRealTimers();
  });

  it("3.1 – constructor registers instance in the static set", async () => {
    // Clear the registry
    await BaseConnectionPool.shutdownAll();

    const pool = new TestConnectionPool();
    const shutdownSpy = vi.spyOn(pool, "shutdown");

    await BaseConnectionPool.shutdownAll();

    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it("3.2 – shutdownAll uses allSettled (one failure does not block others)", async () => {
    await BaseConnectionPool.shutdownAll(); // clear

    const goodPool = new TestConnectionPool();
    const goodSpy = vi.spyOn(goodPool, "shutdown");

    // Create a pool whose shutdown throws
    class FailingPool extends TestConnectionPool {
      override async shutdown() {
        throw new Error("shutdown kaboom");
      }
    }
    new FailingPool(); // registers itself with BaseConnectionPool

    // shutdownAll should not throw, and goodPool's shutdown should still run
    await expect(BaseConnectionPool.shutdownAll()).resolves.toBeUndefined();
    expect(goodSpy).toHaveBeenCalledTimes(1);
  });

  it("3.3 – shutdownAll clears the instances set (second call is no-op)", async () => {
    await BaseConnectionPool.shutdownAll(); // clear

    const pool = new TestConnectionPool();
    const spy = vi.spyOn(pool, "shutdown");

    await BaseConnectionPool.shutdownAll(); // first real call
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    await BaseConnectionPool.shutdownAll(); // second call — set is empty
    expect(spy).not.toHaveBeenCalled();
  });

  it("3.4 – shutdownAll on empty registry is a no-op", async () => {
    await BaseConnectionPool.shutdownAll(); // ensure empty
    // Should not throw or do anything
    await expect(BaseConnectionPool.shutdownAll()).resolves.toBeUndefined();
  });

  it("3.5 – shutdown stops idle timer and closes all pools", async () => {
    config.poolTimeouts.idleTimeoutMs = 20_000;
    const pool = new TestConnectionPool();
    await pool.testInitializePool("a", TEST_CONFIG, TEST_CONTEXT);
    await pool.testInitializePool("b", TEST_CONFIG, TEST_CONTEXT);

    await pool.shutdown();

    // Both pools should be closed
    expect(pool.getPoolsMap().get("a")!.isInitialized).toBe(false);
    expect(pool.getPoolsMap().get("b")!.isInitialized).toBe(false);
    expect(mockPoolInstance.end).toHaveBeenCalledTimes(2);

    // Idle timer should be stopped — advancing time should not close anything
    // (already closed, but verifying no errors from orphaned intervals)
    await vi.advanceTimersByTimeAsync(60_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 4 – SourceManager.getHealthSummary
// ═══════════════════════════════════════════════════════════════════════════
describe("SourceManager – getHealthSummary", () => {
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

  it("4.1 – all pools healthy → hasUnhealthy is false", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("src-a", {
      host: "a",
      user: "u",
      password: "p",
      port: 8076,
    });
    await sm.registerSource("src-b", {
      host: "b",
      user: "u",
      password: "p",
      port: 8076,
    });

    // Mark both as healthy (simulate successful init)
    for (const [, state] of sm.getPoolsMap()) {
      state.isInitialized = true;
      state.healthStatus = "healthy";
    }

    const summary = sm.getHealthSummary();
    const statuses = Object.values(summary).map((s) => s.healthStatus);
    const hasUnhealthy = statuses.some((s) => s === "unhealthy");

    expect(hasUnhealthy).toBe(false);
    expect(Object.keys(summary)).toHaveLength(2);
  });

  it("4.2 – one pool unhealthy → detected in summary", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("good", {
      host: "a",
      user: "u",
      password: "p",
      port: 8076,
    });
    await sm.registerSource("bad", {
      host: "b",
      user: "u",
      password: "p",
      port: 8076,
    });

    const pools = sm.getPoolsMap();
    pools.get("good")!.healthStatus = "healthy";
    pools.get("good")!.isInitialized = true;
    pools.get("bad")!.healthStatus = "unhealthy";

    const summary = sm.getHealthSummary();
    expect(summary["good"]?.healthStatus).toBe("healthy");
    expect(summary["bad"]?.healthStatus).toBe("unhealthy");

    const hasUnhealthy = Object.values(summary).some(
      (s) => s.healthStatus === "unhealthy",
    );
    expect(hasUnhealthy).toBe(true);
  });

  it("4.3 – no pools → empty summary", () => {
    const sm = new TestSourceManager();
    const summary = sm.getHealthSummary();
    expect(summary).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 5 – SourceManager.registerSource pool reuse (issue #212)
// ═══════════════════════════════════════════════════════════════════════════
describe("SourceManager – registerSource pool reuse", () => {
  const SOURCE = {
    host: "system400",
    user: "testuser",
    password: "testpass",
    port: 8076,
  };

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

  it("5.1 – re-register with same settings keeps the live pool", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("ibmi-system", SOURCE);

    const state = sm.getPoolsMap().get("ibmi-system")!;
    const fakePool = { end: vi.fn().mockResolvedValue(undefined) };
    state.pool = fakePool as never;
    state.isInitialized = true;
    state.healthStatus = "healthy";

    await sm.registerSource("ibmi-system", { ...SOURCE });

    const after = sm.getPoolsMap().get("ibmi-system")!;
    expect(after.pool).toBe(fakePool);
    expect(after.isInitialized).toBe(true);
    expect(fakePool.end).not.toHaveBeenCalled();
  });

  it("5.2 – re-register with changed host closes the old pool", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("ibmi-system", SOURCE);

    const state = sm.getPoolsMap().get("ibmi-system")!;
    const fakePool = { end: vi.fn().mockResolvedValue(undefined) };
    state.pool = fakePool as never;
    state.isInitialized = true;
    state.healthStatus = "healthy";

    await sm.registerSource("ibmi-system", {
      ...SOURCE,
      host: "other400",
    });

    expect(fakePool.end).toHaveBeenCalledTimes(1);
    const after = sm.getPoolsMap().get("ibmi-system")!;
    expect(after.pool).toBeNull();
    expect(after.isInitialized).toBe(false);
    expect(after.config.host).toBe("other400");
  });

  it("5.3 – re-register with changed jdbc-options closes the old pool", async () => {
    const sm = new TestSourceManager();
    await sm.registerSource("ibmi-system", {
      ...SOURCE,
      "jdbc-options": { libraries: ["LIBA"] },
    });

    const state = sm.getPoolsMap().get("ibmi-system")!;
    const fakePool = { end: vi.fn().mockResolvedValue(undefined) };
    state.pool = fakePool as never;
    state.isInitialized = true;

    await sm.registerSource("ibmi-system", {
      ...SOURCE,
      "jdbc-options": { libraries: ["LIBB"] },
    });

    expect(fakePool.end).toHaveBeenCalledTimes(1);
    expect(
      sm.getPoolsMap().get("ibmi-system")!.config.jdbcOptions?.libraries,
    ).toEqual(["LIBB"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 6 – rowsToFetch threading (issue #139)
// ═══════════════════════════════════════════════════════════════════════════
describe("BaseConnectionPool – rowsToFetch threading", () => {
  let pool: TestConnectionPool;

  beforeEach(async () => {
    resetMocks();
    config.poolTimeouts.idleTimeoutMs = 0;
    pool = new TestConnectionPool();
    await pool.testInitializePool("test", TEST_CONFIG, TEST_CONTEXT);
  });

  afterEach(async () => {
    await BaseConnectionPool.shutdownAll();
    restoreConfig();
  });

  it("6.1 – omits rowsToFetch arg when not provided (mapepire default 100 applies)", async () => {
    await pool.testExecuteQuery("test", "SELECT 1");

    // pool.query() called with statement + parameters
    expect(mockPoolInstance.query).toHaveBeenCalledWith("SELECT 1", {
      parameters: undefined,
    });
    // execute() called without rowsToFetch so mapepire uses its default
    expect(mockQueryInstance.execute).toHaveBeenCalledWith();
    // close() always called to release the job
    expect(mockQueryInstance.close).toHaveBeenCalledTimes(1);
  });

  it("6.2 – forwards rowsToFetch to Query.execute(n)", async () => {
    // Use the protected method through a typed subclass cast
    const protectedPool = pool as unknown as {
      executeQuery: (
        poolId: string,
        query: string,
        params?: unknown[],
        context?: Record<string, unknown>,
        securityConfig?: unknown,
        rowsToFetch?: number,
      ) => Promise<unknown>;
    };

    await protectedPool.executeQuery(
      "test",
      "SELECT 1",
      undefined,
      TEST_CONTEXT,
      undefined,
      500,
    );

    expect(mockQueryInstance.execute).toHaveBeenCalledWith(500);
    expect(mockQueryInstance.close).toHaveBeenCalled();
  });

  it("6.3 – close() still called when execute() rejects", async () => {
    mockQueryInstance.execute.mockRejectedValueOnce(new Error("boom"));

    await expect(pool.testExecuteQuery("test", "SELECT 1")).rejects.toThrow(
      /boom/,
    );
    expect(mockQueryInstance.close).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 7 – executeQueryWithPagination row cap
// ═══════════════════════════════════════════════════════════════════════════
describe("BaseConnectionPool – paginated query row cap", () => {
  let pool: TestConnectionPool;

  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: i }));

  beforeEach(async () => {
    resetMocks();
    config.poolTimeouts.idleTimeoutMs = 0;
    pool = new TestConnectionPool();
    await pool.testInitializePool("test", TEST_CONFIG, TEST_CONTEXT);
  });

  afterEach(async () => {
    await BaseConnectionPool.shutdownAll();
    restoreConfig();
  });

  it("7.1 – a complete result of exactly the cap is not flagged truncated", async () => {
    mockQueryInstance.execute.mockResolvedValue({
      ...SUCCESSFUL_RESULT,
      data: rows(MAX_PAGINATION_ROWS),
      is_done: true,
    });

    const result = await pool.testExecuteQueryWithPagination(
      "test",
      "SELECT 1",
    );

    expect(result.data).toHaveLength(MAX_PAGINATION_ROWS);
    expect(result.truncated).toBe(false);
    expect(mockQueryInstance.fetchMore).not.toHaveBeenCalled();
  });

  it("7.2 – stops at the cap and flags truncated when more rows remain", async () => {
    mockQueryInstance.execute.mockResolvedValue({
      ...SUCCESSFUL_RESULT,
      data: rows(MAX_PAGINATION_ROWS),
      is_done: false,
    });

    const result = await pool.testExecuteQueryWithPagination(
      "test",
      "SELECT 1",
    );

    expect(result.data).toHaveLength(MAX_PAGINATION_ROWS);
    expect(result.truncated).toBe(true);
    expect(mockQueryInstance.fetchMore).not.toHaveBeenCalled();
  });

  it("7.3 – trims a final page that overshoots the cap and flags truncated", async () => {
    mockQueryInstance.execute.mockResolvedValue({
      ...SUCCESSFUL_RESULT,
      data: rows(MAX_PAGINATION_ROWS - 1),
      is_done: false,
    });
    mockQueryInstance.fetchMore.mockResolvedValue({
      ...SUCCESSFUL_RESULT,
      data: rows(2),
      is_done: true,
    });

    const result = await pool.testExecuteQueryWithPagination(
      "test",
      "SELECT 1",
    );

    expect(result.data).toHaveLength(MAX_PAGINATION_ROWS);
    expect(result.truncated).toBe(true);
  });

  it("7.4 – marks the pool healthy after a successful paginated query", async () => {
    const state = pool.getPoolsMap().get("test")!;
    state.healthStatus = "unknown";
    mockQueryInstance.execute.mockResolvedValue({
      ...SUCCESSFUL_RESULT,
      is_done: true,
    });

    await pool.testExecuteQueryWithPagination("test", "SELECT 1");

    expect(state.healthStatus).toBe("healthy");
    expect(mockQueryInstance.close).toHaveBeenCalledTimes(1);
  });

  it("7.5 – closes the query when a later fetch fails", async () => {
    mockQueryInstance.execute.mockResolvedValue({
      ...SUCCESSFUL_RESULT,
      is_done: false,
    });
    mockQueryInstance.fetchMore.mockRejectedValue(new Error("fetch failed"));

    await expect(
      pool.testExecuteQueryWithPagination("test", "SELECT 1"),
    ).rejects.toThrow(/fetch failed/);

    expect(mockQueryInstance.close).toHaveBeenCalledTimes(1);
  });

  it("7.6 – fetches the first page with the configured fetch size", async () => {
    mockQueryInstance.execute.mockResolvedValue({
      ...SUCCESSFUL_RESULT,
      is_done: true,
    });

    await pool.testExecuteQueryWithPagination("test", "SELECT 1");

    // Not mapepire's 100-row default, which would cost an extra round trip
    expect(mockQueryInstance.execute).toHaveBeenCalledWith(DEFAULT_PAGE_SIZE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group 8 – mapepire global query list pruning
// ═══════════════════════════════════════════════════════════════════════════
describe("BaseConnectionPool – prunes mapepire's global query list", () => {
  let pool: TestConnectionPool;
  // mapepire's Query class exposes a static cleanup(); the pool reaches it
  // through the query instance's constructor.
  const cleanup = vi.fn();

  beforeEach(async () => {
    resetMocks();
    cleanup.mockReset().mockResolvedValue(undefined);
    mockPoolInstance.query.mockImplementation(
      () =>
        ({
          ...mockQueryInstance,
          constructor: { cleanup },
        }) as never,
    );
    config.poolTimeouts.idleTimeoutMs = 0;
    pool = new TestConnectionPool();
    await pool.testInitializePool("test", TEST_CONFIG, TEST_CONTEXT);
  });

  afterEach(async () => {
    await BaseConnectionPool.shutdownAll();
    restoreConfig();
  });

  it("8.1 – after a single-fetch query", async () => {
    await pool.testExecuteQuery("test", "SELECT 1", [], TEST_CONTEXT);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("8.2 – after a failed query", async () => {
    mockQueryInstance.execute.mockRejectedValue(new Error("SQL0204"));

    await expect(
      pool.testExecuteQuery("test", "SELECT 1", [], TEST_CONTEXT),
    ).rejects.toThrow(/SQL0204/);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("8.3 – after a paginated query, without failing it when cleanup rejects", async () => {
    cleanup.mockRejectedValue(new Error("cleanup failed"));
    mockQueryInstance.execute.mockResolvedValue({
      ...SUCCESSFUL_RESULT,
      is_done: true,
    });

    const result = await pool.testExecuteQueryWithPagination(
      "test",
      "SELECT 1",
    );

    expect(result.data).toHaveLength(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
