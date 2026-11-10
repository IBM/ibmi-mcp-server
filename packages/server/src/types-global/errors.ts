/**
 * @fileoverview Defines standardized error codes and a custom error class
 * for handling errors within the Model Context Protocol (MCP) server and its components.
 * This module provides a structured way to represent and communicate errors, ensuring
 * consistency and clarity for both server-side operations and client-side error handling.
 * @module src/types-global/errors
 */

/**
 * Defines JSON-RPC 2.0 error codes, including standard and implementation-defined codes.
 * @see https://www.jsonrpc.org/specification#error_object
 */
export enum JsonRpcErrorCode {
  // Standard JSON-RPC 2.0 Errors
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,

  // Implementation-defined server-errors (-32000 to -32099)
  ServiceUnavailable = -32000,
  NotFound = -32001,
  Conflict = -32002,
  RateLimited = -32003,
  Timeout = -32004,
  Forbidden = -32005,
  Unauthorized = -32006,
  ValidationError = -32007,
  ConfigurationError = -32008,
  InitializationFailed = -32009,
  DatabaseError = -32010,
  UnknownError = -32099, // A generic fallback
}

/**
 * Custom error class for MCP-specific errors, extending the built-in `Error` class.
 * It standardizes error reporting by encapsulating a `JsonRpcErrorCode`, a descriptive
 * human-readable message, and optional structured details for more context.
 *
 * This class is central to error handling within the MCP framework, allowing for
 * consistent error creation and propagation.
 */
export class McpError extends Error {
  /**
   * The standardized error code from {@link JsonRpcErrorCode}.
   */
  public code: JsonRpcErrorCode;

  /**
   * Optional additional details or context about the error.
   * This can be any structured data that helps in understanding or debugging the error.
   */
  public readonly details?: Record<string, unknown>;

  /**
   * Creates an instance of McpError.
   *
   * @param code - The standardized error code that categorizes the error.
   * @param message - A human-readable description of the error.
   * @param details - Optional. A record containing additional structured details about the error.
   */
  constructor(
    code: JsonRpcErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);

    this.code = code;
    this.details = details;
    this.name = "McpError";

    // Maintain a proper prototype chain.
    Object.setPrototypeOf(this, McpError.prototype);

    // Capture the stack trace, excluding the constructor call from it, if available.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, McpError);
    }
  }
}
