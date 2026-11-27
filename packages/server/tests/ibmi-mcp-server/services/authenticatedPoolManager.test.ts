/**
 * @fileoverview Tests for AuthenticatedPoolManager secret handling.
 * Pool ids are bearer tokens, so they must never reach logs or client-facing
 * errors, and a failed sign-on must not leave credentials behind.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PoolConnectionConfig } from "../../../src/ibmi-mcp-server/services/baseConnectionPool.js";

// ---------------------------------------------------------------------------
// Hoisted mock state – vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------
const { mockPoolInstance, mockQueryInstance, MockPool } = vi.hoisted(() => {
  const mockQueryInstance = {
    execute: vi.fn(),
    fetchMore: vi.fn(),
    close: vi.fn(),
  };
  const query = vi.fn(() => mockQueryInstance);
  const mockPoolInstance = {
    init: vi.fn(),
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
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("@ibm/mapepire-js", () => ({
  default: {
    Pool: MockPool,
    getRootCertificate: vi.fn().mockResolvedValue("cert"),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
// Must load first: AuthenticatedPoolManager imports logger from this barrel,
// which is circular with utils/internal (see jdbcOptions.test.ts).
import "../../../src/utils/index.js";
import { BaseConnectionPool } from "../../../src/ibmi-mcp-server/services/baseConnectionPool.js";
import { AuthenticatedPoolManager } from "../../../src/ibmi-mcp-server/services/authenticatedPoolManager.js";
import { TokenManager } from "../../../src/ibmi-mcp-server/auth/tokenManager.js";
import { config } from "../../../src/config/index.js";
import { logger } from "../../../src/utils/internal/index.js";

const CREDENTIALS = {
  host: "user-host",
  user: "signedon",
  password: "userpass",
  rejectUnauthorized: false,
};

const TEST_CONTEXT = {
  requestId: "auth-pool-test",
  timestamp: new Date().toISOString(),
  operation: "Test",
};

const ORIGINAL_IDLE_TIMEOUT = config.poolTimeouts.idleTimeoutMs;
const ORIGINAL_QUERY_TIMEOUT = config.poolTimeouts.queryTimeoutMs;

function getState(token: string) {
  const manager = AuthenticatedPoolManager.getInstance() as unknown as {
    pools: Map<string, { config: PoolConnectionConfig }>;
    credentialsMap: Map<string, unknown>;
  };
  return {
    poolState: manager.pools.get(token),
    storedCredentials: manager.credentialsMap.get(token),
  };
}

describe("AuthenticatedPoolManager – secret handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockPool.mockClear();
    mockPoolInstance.init.mockReset().mockResolvedValue(undefined);
    mockPoolInstance.end.mockReset().mockResolvedValue(undefined);
    mockPoolInstance.query
      .mockReset()
      .mockImplementation(() => mockQueryInstance);
    mockQueryInstance.execute.mockReset();
    mockQueryInstance.fetchMore.mockReset();
    mockQueryInstance.close.mockReset().mockResolvedValue(undefined);
    config.poolTimeouts.queryTimeoutMs = 1_000;
    config.poolTimeouts.idleTimeoutMs = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // The singleton outlives shutdownAll's registry, so stop it directly
    await AuthenticatedPoolManager.getInstance().shutdown();
    await BaseConnectionPool.shutdownAll();
    config.poolTimeouts.idleTimeoutMs = ORIGINAL_IDLE_TIMEOUT;
    config.poolTimeouts.queryTimeoutMs = ORIGINAL_QUERY_TIMEOUT;
    vi.useRealTimers();
  });

  it("drops stored credentials and the pool entry when sign-on fails", async () => {
    mockPoolInstance.init.mockRejectedValueOnce(
      new Error("Password is incorrect"),
    );

    await expect(
      AuthenticatedPoolManager.getInstance().createPool(
        "token-bad-signon",
        CREDENTIALS,
        {},
        TEST_CONTEXT as never,
      ),
    ).rejects.toThrow(/sign-on failed/i);

    const { poolState, storedCredentials } = getState("token-bad-signon");
    expect(poolState).toBeUndefined();
    expect(storedCredentials).toBeUndefined();
  });

  it("removes the pool and its credentials once the token has expired", async () => {
    const manager = AuthenticatedPoolManager.getInstance();
    const sweepSeconds = config.ibmiHttpAuth.cleanupIntervalSeconds;
    // Token outlives the first sweep and expires before the second
    const token = TokenManager.getInstance().generateToken(
      CREDENTIALS,
      sweepSeconds + 1,
    );
    await manager.createPool(token, CREDENTIALS, {}, TEST_CONTEXT as never);

    // First sweep: token still valid, so the pool stays
    await vi.advanceTimersByTimeAsync(sweepSeconds * 1000);
    expect(getState(token).poolState).toBeDefined();
    expect(mockPoolInstance.end).not.toHaveBeenCalled();

    // Second sweep: token has expired
    await vi.advanceTimersByTimeAsync(sweepSeconds * 1000);

    expect(mockPoolInstance.end).toHaveBeenCalled();
    const { poolState, storedCredentials } = getState(token);
    expect(poolState).toBeUndefined();
    expect(storedCredentials).toBeUndefined();
  });

  it("never writes the bearer token to logs or timeout errors", async () => {
    const logSpies = [
      vi.spyOn(logger, "debug"),
      vi.spyOn(logger, "info"),
      vi.spyOn(logger, "warning"),
      vi.spyOn(logger, "error"),
    ];

    const manager = AuthenticatedPoolManager.getInstance();
    const token = TokenManager.getInstance().generateToken(CREDENTIALS);
    await manager.createPool(token, CREDENTIALS, {}, TEST_CONTEXT as never);

    // execute never resolves → the query timeout fires and the pool is closed
    mockQueryInstance.execute.mockReturnValue(new Promise(() => {}));
    const queryPromise = manager
      .executeQuery(token, "SELECT 1", [], TEST_CONTEXT as never)
      .catch((e: unknown) => e as Error & { details?: unknown });
    await vi.advanceTimersByTimeAsync(1_001);
    const error = await queryPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timed out/i);
    expect(
      JSON.stringify([
        (error as Error).message,
        (error as { details?: unknown }).details,
      ]),
    ).not.toContain(token);

    const logged = logSpies.flatMap((spy) =>
      spy.mock.calls.map((call) => JSON.stringify(call)),
    );
    for (const entry of logged) {
      expect(entry).not.toContain(token);
    }
    // The pool is still identifiable in logs, by a one-way fingerprint
    expect(
      logged.some((entry) =>
        /Query timed out on pool 'token:[0-9a-f]{12}'/.test(entry),
      ),
    ).toBe(true);
  });
});
