/**
 * Helpers for normalizing tool-logic results that encode failure as
 * `{ success: false }` instead of throwing.
 *
 * Factory-pattern tools historically returned soft-failure objects. MCP
 * clients only see `isError: true` when the handler throws, and
 * `measureToolExecution` only marks `isSuccess: false` on throw. These
 * helpers convert soft failures into `McpError` so both signals are correct.
 *
 * @see https://github.com/IBM/ibmi-mcp-server/issues/205
 */

import { JsonRpcErrorCode, McpError } from "../../../types-global/errors.js";

/**
 * Shape of a soft-failure result returned by some tool logic functions.
 */
export type SoftFailureResult = {
  success: false;
  error?: {
    code?: string | number;
    message?: string;
    details?: Record<string, unknown>;
  };
};

/**
 * Returns true when `result` is an object with `success: false`.
 */
export function isSoftFailureResult(
  result: unknown,
): result is SoftFailureResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "success" in result &&
    (result as { success: unknown }).success === false
  );
}

/**
 * Maps a string/number error code onto {@link JsonRpcErrorCode}, falling
 * back to InternalError when the value is unrecognized.
 */
export function resolveJsonRpcErrorCode(
  code: string | number | undefined,
): JsonRpcErrorCode {
  if (typeof code === "number") {
    if (
      (Object.values(JsonRpcErrorCode) as Array<string | number>).includes(
        code,
      )
    ) {
      return code as JsonRpcErrorCode;
    }
    return JsonRpcErrorCode.InternalError;
  }

  if (typeof code === "string" && code.length > 0) {
    const asNumber = Number(code);
    if (
      !Number.isNaN(asNumber) &&
      (Object.values(JsonRpcErrorCode) as Array<string | number>).includes(
        asNumber,
      )
    ) {
      return asNumber as JsonRpcErrorCode;
    }
  }

  return JsonRpcErrorCode.InternalError;
}

/**
 * Converts a soft-failure tool result into an {@link McpError}.
 */
export function softFailureToMcpError(result: SoftFailureResult): McpError {
  const message = result.error?.message?.trim() || "Tool execution failed";
  const code = resolveJsonRpcErrorCode(result.error?.code);
  return new McpError(code, message, result.error?.details);
}

/**
 * Passes through successful tool results; throws {@link McpError} when the
 * result encodes a soft failure (`success: false`).
 */
export function ensureToolLogicSuccess<T>(result: T): T {
  if (isSoftFailureResult(result)) {
    throw softFailureToMcpError(result);
  }
  return result;
}
