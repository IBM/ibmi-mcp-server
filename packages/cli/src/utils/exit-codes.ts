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

/** A CLI-side refusal to run a statement (e.g. an access ceiling). */
export class SecurityViolationError extends Error {
  override name = "SecurityViolationError";
}

/**
 * The `details.rule` of an execute_sql guardrail rejection (an McpError
 * whose details carry `rule` and `access`), else undefined.
 */
function guardrailRule(error: Error): string | undefined {
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return undefined;
  const { rule, access } = details as Record<string, unknown>;
  return typeof rule === "string" && typeof access === "string"
    ? rule
    : undefined;
}

/**
 * Classify an error into an exit code and error code based on its message and type.
 *
 * Guardrail rejections (every rule, including `unverifiable`: the statement
 * was not run because PARSE_STATEMENT could not verify it) and CLI security
 * refusals are classified by type. A PARSE_STATEMENT execution failure is
 * rethrown unchanged by the guardrail and classified by its message.
 * Otherwise pattern matching is intentionally broad —
 * we check common patterns from Mapepire, SqlSecurityValidator, and our own
 * error messages.
 */
export function classifyError(error: Error): ClassifiedError {
  if (
    error instanceof SecurityViolationError ||
    guardrailRule(error) !== undefined
  ) {
    return {
      exitCode: ExitCode.SECURITY,
      errorCode: ErrorCode.SECURITY_VIOLATION,
      message: error.message,
    };
  }

  const msg = error.message.toLowerCase();

  // Authentication failures
  if (
    msg.includes("authentication") ||
    msg.includes("unauthorized") ||
    msg.includes("credentials") ||
    msg.includes("password") ||
    msg.includes("login failed") ||
    msg.includes("auth")
  ) {
    return {
      exitCode: ExitCode.AUTH,
      errorCode: ErrorCode.AUTH_FAILURE,
      message: error.message,
    };
  }

  // Security violations
  if (
    msg.includes("read-only") ||
    msg.includes("readonly") ||
    msg.includes("security") ||
    msg.includes("forbidden") ||
    msg.includes("blocked") ||
    msg.includes("not allowed") ||
    msg.includes("mutation")
  ) {
    return {
      exitCode: ExitCode.SECURITY,
      errorCode: ErrorCode.SECURITY_VIOLATION,
      message: error.message,
    };
  }

  // SQL / query execution errors
  if (
    msg.includes("sql") ||
    msg.includes("query") ||
    msg.includes("sqlcode") ||
    msg.includes("sqlstate") ||
    msg.includes("execute") ||
    msg.includes("syntax error")
  ) {
    return {
      exitCode: ExitCode.QUERY,
      errorCode: ErrorCode.SQL_ERROR,
      message: error.message,
    };
  }

  // Connection errors
  if (
    msg.includes("connect") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("socket")
  ) {
    return {
      exitCode: ExitCode.GENERAL,
      errorCode: ErrorCode.CONNECTION_ERROR,
      message: error.message,
    };
  }

  // Not found
  if (
    msg.includes("not found") ||
    msg.includes("does not exist") ||
    msg.includes("no such")
  ) {
    return {
      exitCode: ExitCode.GENERAL,
      errorCode: ErrorCode.NOT_FOUND,
      message: error.message,
    };
  }

  // Default: general error
  return {
    exitCode: ExitCode.GENERAL,
    errorCode: ErrorCode.GENERAL_ERROR,
    message: error.message,
  };
}
