/**
 * @fileoverview The service executor of the query router: when the `ibmi`
 * CLI sets one, statements without a source go to it instead of the
 * `DB2i_*` pool. Statements with a source are not affected.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { Pool } = vi.hoisted(() => ({
  Pool: vi.fn(function () {
    throw new Error("a mapepire-js pool was constructed");
  }),
}));

vi.mock("@ibm/mapepire-js", () => ({
  default: { Pool, getRootCertificate: vi.fn() },
}));

import "../../../src/utils/index.js";
import { IBMiConnectionPool } from "../../../src/ibmi-mcp-server/services/connectionPool.js";
import {
  executeQuery,
  executeQueryWithPagination,
  setServiceQueryExecutor,
  type ServiceQueryExecutor,
} from "../../../src/ibmi-mcp-server/services/queryRouter.js";
import { SourceManager } from "../../../src/ibmi-mcp-server/services/sourceManager.js";
import { JsonRpcErrorCode } from "../../../src/types-global/errors.js";
import { requestContextService } from "../../../src/utils/internal/requestContext.js";

const ctx = requestContextService.createRequestContext({ operation: "Test" });

function fakeExecutor() {
  return {
    executeQuery: vi.fn(async () => ({ success: true, data: [{ A: 1 }] })),
    executeQueryWithPagination: vi.fn(async () => ({
      success: true,
      data: [{ A: 1 }, { A: 2 }],
      truncated: false,
    })),
  } as unknown as ServiceQueryExecutor & {
    executeQuery: ReturnType<typeof vi.fn>;
    executeQueryWithPagination: ReturnType<typeof vi.fn>;
  };
}

describe("query router service executor", () => {
  afterEach(() => {
    setServiceQueryExecutor(undefined);
    vi.restoreAllMocks();
  });

  it("sends statements without a source to the executor", async () => {
    const executor = fakeExecutor();
    const pool = vi.spyOn(IBMiConnectionPool, "executeQuery");
    setServiceQueryExecutor(executor);

    await expect(
      executeQuery("VALUES 1", [1], ctx, { rowsToFetch: 7 }),
    ).resolves.toMatchObject({ data: [{ A: 1 }] });
    await executeQueryWithPagination("VALUES 2", undefined, ctx, {
      rowsToFetch: 50,
    });

    expect(executor.executeQuery).toHaveBeenCalledWith("VALUES 1", [1], ctx, 7);
    expect(executor.executeQueryWithPagination).toHaveBeenCalledWith(
      "VALUES 2",
      undefined,
      ctx,
      50,
    );
    expect(pool).not.toHaveBeenCalled();
  });

  it("still checks the security settings before it sends anything", async () => {
    const executor = fakeExecutor();
    setServiceQueryExecutor(executor);

    await expect(
      executeQuery("DELETE FROM T", [], ctx, {
        securityConfig: { readOnly: true },
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(executor.executeQuery).not.toHaveBeenCalled();
  });

  it("leaves statements with a source on that source's pool", async () => {
    const executor = fakeExecutor();
    setServiceQueryExecutor(executor);
    const sourceManager = new SourceManager();
    const sourceQuery = vi
      .spyOn(sourceManager, "executeQuery")
      .mockResolvedValue({ success: true, data: [] } as never);

    await executeQuery("VALUES 1", [], ctx, { source: "dev", sourceManager });

    expect(sourceQuery).toHaveBeenCalledOnce();
    expect(executor.executeQuery).not.toHaveBeenCalled();
  });

  it("uses the DB2i_* pool again once the executor is removed", async () => {
    setServiceQueryExecutor(fakeExecutor());
    setServiceQueryExecutor(undefined);
    const pool = vi
      .spyOn(IBMiConnectionPool, "executeQuery")
      .mockResolvedValue({ success: true, data: [] } as never);

    await executeQuery("VALUES 1", [], ctx);
    expect(pool).toHaveBeenCalledOnce();
  });
});
