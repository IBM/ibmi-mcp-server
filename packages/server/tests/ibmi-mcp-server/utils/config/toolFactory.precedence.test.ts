/**
 * @fileoverview Precedence tests for SQLToolFactory fetch controls.
 *
 * Verifies the rowsToFetch vs fetchAllRows decision in
 * SQLToolFactory.executeWithAuthRouting (issue #139 follow-up):
 *   - rowsToFetch alone  → executeQuery(rowsToFetch)
 *   - fetchAllRows alone → executeQueryWithPagination
 *   - both set           → executeQuery(rowsToFetch) + WARN logged,
 *                          executeQueryWithPagination NOT called
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Override the global logger no-op mock with spies so we can assert the warn.
// vi.hoisted lets us reference these symbols from the hoisted vi.mock factory.
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

/**
 * Minimal mapepire-compatible QueryResult for the executeQuery path.
 */
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

/**
 * Minimal paginated result shape consumed by toolFactory at lines 312-325.
 */
function makePaginatedResult() {
  return {
    success: true,
    data: [],
    metadata: { columns: [] },
    sql_rc: 0,
    execution_time: 1,
  };
}

/**
 * Builds a stub SourceManager that exposes spied versions of the two methods
 * the factory chooses between. Only the properties SQLToolFactory touches
 * need to be present — the rest of the SourceManager surface is unused here.
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

describe("SQLToolFactory fetch-control precedence", () => {
  beforeEach(() => {
    warningSpy.mockClear();
  });

  it("only rowsToFetch → executeQuery called with rowsToFetch, no pagination", async () => {
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

  it("only fetchAllRows → executeQueryWithPagination called, no executeQuery", async () => {
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
    expect(executeQuery).not.toHaveBeenCalled();
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it("both set → rowsToFetch wins, fetchAllRows ignored, WARN emitted", async () => {
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

    expect(executeQuery).toHaveBeenCalledTimes(1);
    const args = executeQuery.mock.calls[0];
    expect(args[args.length - 1]).toBe(500);
    expect(executeQueryWithPagination).not.toHaveBeenCalled();

    expect(warningSpy).toHaveBeenCalledTimes(1);
    const [logCtx, logMsg] = warningSpy.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(logCtx).toMatchObject({ rowsToFetch: 500, fetchAllRows: true });
    expect(logMsg).toMatch(/rowsToFetch/);
    expect(logMsg).toMatch(/fetchAllRows/);
  });
});
