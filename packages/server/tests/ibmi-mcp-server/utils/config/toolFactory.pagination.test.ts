/**
 * @fileoverview Composition tests for SQLToolFactory fetch controls.
 *
 * Verifies the rowsToFetch / fetchAllRows decision in
 * SQLToolFactory.executeWithAuthRouting:
 *   - rowsToFetch alone        → executeQuery(rowsToFetch)
 *   - fetchAllRows alone       → executeQueryWithPagination, fetchSize undefined
 *   - both set                 → executeQueryWithPagination, fetchSize = rowsToFetch
 *   - neither set              → executeQuery with no explicit size
 *
 * Replaces the prior precedence rule ("rowsToFetch wins when both are set")
 * with composable semantics: fetchAllRows is the pagination policy,
 * rowsToFetch (when set alongside) is the per-fetch page size.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Replace the module-level logger with spies so we can assert no warnings
// are emitted now that the precedence collision no longer exists.
const { warningSpy } = vi.hoisted(() => ({ warningSpy: vi.fn() }));

vi.mock("../../../../src/utils/internal/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    warning: warningSpy,
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Block the scheduler singleton (loaded transitively via the utils barrel).
vi.mock("../../../../src/utils/scheduling/index.js", () => ({
  SchedulerService: { getInstance: vi.fn() },
  schedulerService: {},
}));

import { SQLToolFactory } from "../../../../src/ibmi-mcp-server/utils/config/toolFactory.js";
import type { SourceManager } from "../../../../src/ibmi-mcp-server/services/sourceManager.js";

/** Minimal mapepire-compatible QueryResult for the single-shot path. */
function makeExecuteResult() {
  return {
    success: true,
    data: [],
    metadata: { columns: [] },
    sql_rc: 0,
    execution_time: 1,
    is_done: true,
    has_results: false,
    update_count: 0,
    id: "",
    sql_state: "",
  };
}

/** Minimal paginated result shape consumed by toolFactory's adapter. */
function makePaginatedResult() {
  return {
    success: true,
    data: [],
    metadata: { columns: [] },
    sql_rc: 0,
    execution_time: 1,
    truncated: false,
  };
}

/**
 * Builds a stub SourceManager that exposes spied versions of the two methods
 * the factory chooses between.
 */
function makeStubSourceManager() {
  const executeQuery = vi.fn().mockResolvedValue(makeExecuteResult());
  const executeQueryWithPagination = vi
    .fn()
    .mockResolvedValue(makePaginatedResult());
  const stub = {
    executeQuery,
    executeQueryWithPagination,
  } as unknown as SourceManager;
  return { stub, executeQuery, executeQueryWithPagination };
}

describe("SQLToolFactory fetch-control composition", () => {
  beforeEach(() => {
    warningSpy.mockClear();
  });

  it("rowsToFetch alone → executeQuery called with rowsToFetch, no pagination", async () => {
    const { stub, executeQuery, executeQueryWithPagination } =
      makeStubSourceManager();
    SQLToolFactory.initialize(stub);

    await SQLToolFactory.executeStatementWithParameters(
      "t",
      "ibmi",
      "SELECT 1",
      {},
      [],
      undefined,
      undefined,
      500,
      undefined,
    );

    expect(executeQuery).toHaveBeenCalledTimes(1);
    const args = executeQuery.mock.calls[0];
    expect(args[args.length - 1]).toBe(500);
    expect(executeQueryWithPagination).not.toHaveBeenCalled();
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it("fetchAllRows alone → executeQueryWithPagination called, fetchSize undefined", async () => {
    const { stub, executeQuery, executeQueryWithPagination } =
      makeStubSourceManager();
    SQLToolFactory.initialize(stub);

    await SQLToolFactory.executeStatementWithParameters(
      "t",
      "ibmi",
      "SELECT 1",
      {},
      [],
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(executeQueryWithPagination).toHaveBeenCalledTimes(1);
    // Signature: (sourceName, query, params, context, fetchSize, securityConfig)
    // fetchSize is the 5th positional argument (index 4).
    const args = executeQueryWithPagination.mock.calls[0];
    expect(args[4]).toBeUndefined();
    expect(executeQuery).not.toHaveBeenCalled();
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it("both set → executeQueryWithPagination called, fetchSize = rowsToFetch", async () => {
    const { stub, executeQuery, executeQueryWithPagination } =
      makeStubSourceManager();
    SQLToolFactory.initialize(stub);

    await SQLToolFactory.executeStatementWithParameters(
      "t",
      "ibmi",
      "SELECT 1",
      {},
      [],
      undefined,
      undefined,
      500,
      true,
    );

    expect(executeQueryWithPagination).toHaveBeenCalledTimes(1);
    const args = executeQueryWithPagination.mock.calls[0];
    expect(args[4]).toBe(500);
    expect(executeQuery).not.toHaveBeenCalled();
    // No warning — the two fields compose, there's no collision anymore.
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it("neither set → executeQuery called without an explicit row cap", async () => {
    const { stub, executeQuery, executeQueryWithPagination } =
      makeStubSourceManager();
    SQLToolFactory.initialize(stub);

    await SQLToolFactory.executeStatementWithParameters(
      "t",
      "ibmi",
      "SELECT 1",
      {},
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(executeQuery).toHaveBeenCalledTimes(1);
    const args = executeQuery.mock.calls[0];
    // The last argument in the no-rowsToFetch branch is the context, not a
    // number — assert we did not pass a numeric cap.
    expect(typeof args[args.length - 1]).not.toBe("number");
    expect(executeQueryWithPagination).not.toHaveBeenCalled();
    expect(warningSpy).not.toHaveBeenCalled();
  });
});
