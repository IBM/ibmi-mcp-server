/**
 * Unit tests for soft-failure → McpError helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../src/types-global/errors.js";

// Config schema expects OTEL_ENABLED as a string; vitest does not load the
// repo-root .env, so set a safe default before modules that import config.
vi.hoisted(() => {
  process.env.OTEL_ENABLED ??= "false";
});

vi.mock("../../src/utils/internal/performance.js", () => ({
  measureToolExecution: vi.fn(async (_toolName: string, toolLogicFn: () => Promise<unknown>) =>
    toolLogicFn(),
  ),
}));

vi.mock("../../src/utils/internal/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  ensureToolLogicSuccess,
  isSoftFailureResult,
  resolveJsonRpcErrorCode,
  softFailureToMcpError,
} from "../../src/mcp-server/tools/utils/toolSuccess.js";
import { createHandler } from "../../src/mcp-server/tools/utils/tool-factory.js";
import { measureToolExecution } from "../../src/utils/internal/performance.js";

describe("toolSuccess helpers", () => {
  describe("isSoftFailureResult", () => {
    it("detects success: false objects", () => {
      expect(isSoftFailureResult({ success: false })).toBe(true);
      expect(
        isSoftFailureResult({
          success: false,
          error: { message: "boom" },
        }),
      ).toBe(true);
    });

    it("rejects successful or unrelated values", () => {
      expect(isSoftFailureResult({ success: true })).toBe(false);
      expect(isSoftFailureResult({ data: [] })).toBe(false);
      expect(isSoftFailureResult(null)).toBe(false);
      expect(isSoftFailureResult("error")).toBe(false);
    });
  });

  describe("resolveJsonRpcErrorCode", () => {
    it("maps numeric and string enum values", () => {
      expect(resolveJsonRpcErrorCode(JsonRpcErrorCode.DatabaseError)).toBe(
        JsonRpcErrorCode.DatabaseError,
      );
      expect(
        resolveJsonRpcErrorCode(String(JsonRpcErrorCode.ValidationError)),
      ).toBe(JsonRpcErrorCode.ValidationError);
    });

    it("falls back to InternalError for unknown codes", () => {
      expect(resolveJsonRpcErrorCode(undefined)).toBe(
        JsonRpcErrorCode.InternalError,
      );
      expect(resolveJsonRpcErrorCode("not-a-code")).toBe(
        JsonRpcErrorCode.InternalError,
      );
      expect(resolveJsonRpcErrorCode(99999)).toBe(
        JsonRpcErrorCode.InternalError,
      );
    });
  });

  describe("softFailureToMcpError / ensureToolLogicSuccess", () => {
    it("converts soft failures into McpError with details", () => {
      const error = softFailureToMcpError({
        success: false,
        error: {
          code: String(JsonRpcErrorCode.DatabaseError),
          message: "SQL query execution failed",
          details: { sqlReturnCode: -1 },
        },
      });

      expect(error).toBeInstanceOf(McpError);
      expect(error.code).toBe(JsonRpcErrorCode.DatabaseError);
      expect(error.message).toBe("SQL query execution failed");
      expect(error.details).toEqual({ sqlReturnCode: -1 });
    });

    it("throws on soft failure and returns success results", () => {
      expect(() =>
        ensureToolLogicSuccess({
          success: false,
          error: { message: "nope" },
        }),
      ).toThrow(McpError);

      const ok = { success: true as const, data: [1] };
      expect(ensureToolLogicSuccess(ok)).toBe(ok);
    });
  });
});

describe("createHandler soft-failure handling (#205)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns isError:true when logic returns { success: false }", async () => {
    const handler = createHandler(
      "execute_sql",
      async () => ({
        success: false as const,
        error: {
          code: String(JsonRpcErrorCode.DatabaseError),
          message: "SQL query execution failed",
          details: { sql: "SELECT 1" },
        },
      }),
      (result) => [{ type: "text", text: JSON.stringify(result) }],
    );

    const response = await handler({ sql: "SELECT 1" }, {});

    expect(response.isError).toBe(true);
    expect(response.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("SQL query execution failed"),
    });
    expect(response.structuredContent).toMatchObject({
      code: JsonRpcErrorCode.DatabaseError,
      message: "SQL query execution failed",
      details: { sql: "SELECT 1" },
    });
  });

  it("does not set isError when logic returns success: true", async () => {
    const handler = createHandler("execute_sql", async () => ({
      success: true,
      data: [{ A: 1 }],
    }));

    const response = await handler({ sql: "SELECT 1" }, {});

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({
      success: true,
      data: [{ A: 1 }],
    });
  });

  it("runs soft-failure conversion inside measureToolExecution", async () => {
    const handler = createHandler("describe_sql_object", async () => ({
      success: false as const,
      error: {
        code: String(JsonRpcErrorCode.DatabaseError),
        message: "No SQL DDL generated",
      },
    }));

    await handler(
      { object_name: "T", object_library: "QSYS2", object_type: "TABLE" },
      {},
    );

    expect(measureToolExecution).toHaveBeenCalled();
    const toolLogicFn = vi.mocked(measureToolExecution).mock
      .calls[0]?.[1] as () => Promise<unknown>;

    // The wrapped callback must throw so real measureToolExecution would
    // record isSuccess:false (the bug in #205).
    await expect(toolLogicFn()).rejects.toBeInstanceOf(McpError);
  });
});
