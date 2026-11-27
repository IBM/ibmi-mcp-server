/**
 * @fileoverview CLI exit codes and error classification.
 * Provides semantic exit codes for agent and script consumption.
 * @module cli/utils/exit-codes
 */

/** CLI exit codes for different error categories. */
export const ExitCode = {
  /** Command completed successfully. */
  SUCCESS: 0,
  /** General error (connection failure, unexpected error). */
  GENERAL: 1,
  /** Invalid arguments or usage error. */
  USAGE: 2,
  /** Query execution error (SQL error). */
  QUERY: 3,
  /** Security violation (read-only system, forbidden keyword). */
  SECURITY: 4,
  /** Authentication failure (bad credentials, missing password). */
  AUTH: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** Error code strings for structured JSON error output. */
export const ErrorCode = {
  GENERAL_ERROR: "GENERAL_ERROR",
  USAGE_ERROR: "USAGE_ERROR",
  CONNECTION_ERROR: "CONNECTION_ERROR",
  QUERY_ERROR: "QUERY_ERROR",
  SQL_ERROR: "SQL_ERROR",
  SECURITY_VIOLATION: "SECURITY_VIOLATION",
  AUTH_FAILURE: "AUTH_FAILURE",
  NOT_FOUND: "NOT_FOUND",
  TIMEOUT: "TIMEOUT",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Classified error with exit code and error code. */
export interface ClassifiedError {
  exitCode: ExitCodeValue;
  errorCode: ErrorCodeValue;
  message: string;
}

/** Thrown for invalid arguments or usage; always classified as a usage error. */
export class UsageError extends Error {}

/**
 * Error for a failed server tool result (`{ success: false, error }`).
 * Keeps the JSON-RPC code and details the tool reported, as a thrown server
 * `McpError` has them, so classification does not depend on the message text.
 */
export class ToolError extends Error {
  readonly code?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    error:
      | { code?: string; message?: string; details?: Record<string, unknown> }
      | undefined,
    fallbackMessage: string,
  ) {
    super(error?.message ?? fallbackMessage);
    const code = Number(error?.code);
    if (Number.isInteger(code)) this.code = code;
    this.details = error?.details;
  }
}

/**
 * Server error codes used for classification.
 * Keep in sync with server `JsonRpcErrorCode`.
 */
const RpcCode = {
  ServiceUnavailable: -32000,
  Timeout: -32004,
  Forbidden: -32005,
  Unauthorized: -32006,
  ValidationError: -32007,
  InitializationFailed: -32009,
  DatabaseError: -32010,
} as const;

/** Node.js network and TLS error codes (`error.code`) that mean "could not connect". */
const CONNECTION_CODE =
  /^(ECONN\w+|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ERR_TLS_\w+|\w*CERT\w*|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/;

/** Mapepire appends ", <SQLSTATE>, <SQLCODE>" to database error messages. */
const SQLSTATE_SUFFIX = /, ([0-9A-Z]{5}), -?\d+\s*$/;

// Message fallbacks, used only when the error carries no usable code.
// Whole words only: a table named AUTHORS is not an authentication failure.
const AUTH_MESSAGE =
  /\b(authentication|unauthorized|credentials?|password|login failed)\b|server response: 401\b/i;
const SECURITY_MESSAGE =
  /\b(read-only|readonly|security|forbidden|blocked|not allowed|mutations?)\b/i;
const SQL_MESSAGE = /\b(sql\w*|query|syntax error)\b/i;
const CONNECTION_MESSAGE =
  /\b(connect|connection|econn\w+|enotfound|etimedout|ehostunreach|timeout|timed out|socket|certificate)\b/i;
const NOT_FOUND_MESSAGE = /\b(not found|does not exist|no such)\b/i;

/**
 * Classify an error into an exit code and error code.
 *
 * Structured information wins: a {@link UsageError}, a Node.js network/TLS
 * code on the error or its causes, the SQLSTATE Mapepire reports, then the
 * server's JSON-RPC code. Message matching is only the fallback.
 */
export function classifyError(error: Error): ClassifiedError {
  const classified = (
    exitCode: ExitCodeValue,
    errorCode: ErrorCodeValue,
  ): ClassifiedError => ({ exitCode, errorCode, message: error.message });

  const auth = () => classified(ExitCode.AUTH, ErrorCode.AUTH_FAILURE);
  const security = () =>
    classified(ExitCode.SECURITY, ErrorCode.SECURITY_VIOLATION);
  const sql = () => classified(ExitCode.QUERY, ErrorCode.SQL_ERROR);
  const connection = () =>
    classified(ExitCode.GENERAL, ErrorCode.CONNECTION_ERROR);

  if (error instanceof UsageError) {
    return classified(ExitCode.USAGE, ErrorCode.USAGE_ERROR);
  }

  // Server errors keep the original driver error as `cause`
  let rpcCode: number | undefined;
  let systemCode: string | undefined;
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "number") rpcCode ??= code;
    else if (typeof code === "string") systemCode ??= code;
  }

  if (systemCode && CONNECTION_CODE.test(systemCode)) return connection();

  const msg = error.message;
  const sqlState = SQLSTATE_SUFFIX.exec(msg)?.[1];
  if (sqlState) {
    // Class 08: connection exception. Class 28: invalid authorization.
    if (sqlState.startsWith("08")) return connection();
    if (sqlState.startsWith("28")) return auth();
    return sql();
  }

  if (rpcCode === RpcCode.Unauthorized) return auth();
  if (rpcCode === RpcCode.Forbidden) return security();
  if (rpcCode === RpcCode.ValidationError) {
    // The server uses this code for syntax errors and bad tool parameters
    // too; the SQL security validators add `violations` or `readOnly`.
    const { details } = error as { details?: Record<string, unknown> };
    if (details?.["violations"] || details?.["readOnly"] === true) {
      return security();
    }
  }

  if (rpcCode === RpcCode.Timeout) {
    return classified(ExitCode.GENERAL, ErrorCode.TIMEOUT);
  }
  if (rpcCode === RpcCode.ServiceUnavailable) return connection();

  if (AUTH_MESSAGE.test(msg)) return auth();
  if (SECURITY_MESSAGE.test(msg)) return security();
  if (SQL_MESSAGE.test(msg)) return sql();
  if (CONNECTION_MESSAGE.test(msg)) return connection();
  if (NOT_FOUND_MESSAGE.test(msg)) {
    return classified(ExitCode.GENERAL, ErrorCode.NOT_FOUND);
  }

  // The connection pool reports its failures with one of these two codes
  if (rpcCode === RpcCode.InitializationFailed) return connection();
  if (rpcCode === RpcCode.DatabaseError) return sql();

  return classified(ExitCode.GENERAL, ErrorCode.GENERAL_ERROR);
}
