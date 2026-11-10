/**
 * @fileoverview Tests for the per-tool queryTimeoutMs YAML field.
 *
 * Covers schema validation and that SQLToolFactory forwards the value to
 * the source manager on both the single-shot and the pagination path.
 * The timeout behavior itself is covered in baseConnectionPool.test.ts.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../../src/utils/internal/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    warning: vi.fn(),
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
import { SqlToolConfigSchema } from "../../../../src/ibmi-mcp-server/schemas/config.js";
import type { SourceManager } from "../../../../src/ibmi-mcp-server/services/sourceManager.js";

const BASE_TOOL = {
  source: "ibmi",
  description: "Test tool",
  statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1",
};

function makeStubSourceManager() {
  const executeQuery = vi.fn().mockResolvedValue({
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
  });
  const executeQueryWithPagination = vi.fn().mockResolvedValue({
    success: true,
    data: [],
    metadata: { columns: [] },
    sql_rc: 0,
    execution_time: 1,
    truncated: false,
  });
  const stub = {
    executeQuery,
    executeQueryWithPagination,
  } as unknown as SourceManager;
  return { stub, executeQuery, executeQueryWithPagination };
}

describe("SqlToolConfigSchema – queryTimeoutMs", () => {
  it("is optional", () => {
    const result = SqlToolConfigSchema.safeParse(BASE_TOOL);
    expect(result.success).toBe(true);
    expect(result.data?.queryTimeoutMs).toBeUndefined();
  });

  it("accepts a positive integer", () => {
    const result = SqlToolConfigSchema.safeParse({
      ...BASE_TOOL,
      queryTimeoutMs: 300_000,
    });
    expect(result.success).toBe(true);
    expect(result.data?.queryTimeoutMs).toBe(300_000);
  });

  it("accepts 0 (timeout disabled)", () => {
    const result = SqlToolConfigSchema.safeParse({
      ...BASE_TOOL,
      queryTimeoutMs: 0,
    });
    expect(result.success).toBe(true);
    expect(result.data?.queryTimeoutMs).toBe(0);
  });

  it("rejects negative and fractional values", () => {
    expect(
      SqlToolConfigSchema.safeParse({ ...BASE_TOOL, queryTimeoutMs: -1 })
        .success,
    ).toBe(false);
    expect(
      SqlToolConfigSchema.safeParse({ ...BASE_TOOL, queryTimeoutMs: 1.5 })
        .success,
    ).toBe(false);
  });
});

describe("SQLToolFactory – queryTimeoutMs forwarding", () => {
  it("forwards queryTimeoutMs to executeQuery", async () => {
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
      120_000,
    );

    expect(executeQuery).toHaveBeenCalledTimes(1);
    // Signature: (sourceName, query, params, context, securityConfig, rowsToFetch, queryTimeoutMs)
    const args = executeQuery.mock.calls[0];
    expect(args[5]).toBeUndefined();
    expect(args[6]).toBe(120_000);
    expect(executeQueryWithPagination).not.toHaveBeenCalled();
  });

  it("forwards queryTimeoutMs=0 (falsy) to executeQuery", async () => {
    const { stub, executeQuery } = makeStubSourceManager();
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
      0,
    );

    const args = executeQuery.mock.calls[0];
    expect(args[5]).toBe(500);
    expect(args[6]).toBe(0);
  });

  it("forwards queryTimeoutMs to executeQueryWithPagination", async () => {
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
      120_000,
    );

    expect(executeQueryWithPagination).toHaveBeenCalledTimes(1);
    // Signature: (sourceName, query, params, context, fetchSize, securityConfig, queryTimeoutMs)
    const args = executeQueryWithPagination.mock.calls[0];
    expect(args[6]).toBe(120_000);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it("keeps the existing call shape when queryTimeoutMs is not set", async () => {
    const { stub, executeQuery } = makeStubSourceManager();
    SQLToolFactory.initialize(stub);

    await SQLToolFactory.executeStatementWithParameters(
      "t",
      "ibmi",
      "SELECT 1",
      {},
      [],
    );

    // (sourceName, query, params, context) — no trailing undefined args
    expect(executeQuery.mock.calls[0]).toHaveLength(4);
  });
});
