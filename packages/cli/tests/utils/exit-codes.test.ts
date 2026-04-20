import { describe, it, expect } from "vitest";
import {
  ExitCode,
  ErrorCode,
  classifyError,
} from "../../src/utils/exit-codes";

describe("ExitCode constants", () => {
  it("should define all required exit codes", () => {
    expect(ExitCode.SUCCESS).toBe(0);
    expect(ExitCode.GENERAL).toBe(1);
    expect(ExitCode.USAGE).toBe(2);
    expect(ExitCode.QUERY).toBe(3);
    expect(ExitCode.SECURITY).toBe(4);
    expect(ExitCode.AUTH).toBe(5);
  });
});

describe("classifyError", () => {
  it("should classify authentication errors as AUTH (exit 5)", () => {
    const result = classifyError(new Error("Authentication failed for user QUSER"));
    expect(result.exitCode).toBe(ExitCode.AUTH);
    expect(result.errorCode).toBe(ErrorCode.AUTH_FAILURE);
  });

  it("should classify unauthorized errors as AUTH", () => {
    const result = classifyError(new Error("401 Unauthorized"));
    expect(result.exitCode).toBe(ExitCode.AUTH);
    expect(result.errorCode).toBe(ErrorCode.AUTH_FAILURE);
  });

  it("should classify password errors as AUTH", () => {
    const result = classifyError(new Error("Password expired or invalid"));
    expect(result.exitCode).toBe(ExitCode.AUTH);
  });

  it("should classify read-only violations as SECURITY (exit 4)", () => {
    const result = classifyError(new Error("System is read-only. Mutation queries are not allowed."));
    expect(result.exitCode).toBe(ExitCode.SECURITY);
    expect(result.errorCode).toBe(ErrorCode.SECURITY_VIOLATION);
  });

  it("should classify forbidden keyword errors as SECURITY", () => {
    const result = classifyError(new Error("Forbidden keyword: DROP TABLE"));
    expect(result.exitCode).toBe(ExitCode.SECURITY);
  });

  it("should classify blocked query errors as SECURITY", () => {
    const result = classifyError(new Error("Query blocked by security policy"));
    expect(result.exitCode).toBe(ExitCode.SECURITY);
  });

  it("should classify SQL errors as QUERY (exit 3)", () => {
    const result = classifyError(new Error("SQL0204 - CUSTMAST in MYLIB not found"));
    expect(result.exitCode).toBe(ExitCode.QUERY);
    expect(result.errorCode).toBe(ErrorCode.SQL_ERROR);
  });

  it("should classify query execution errors as QUERY", () => {
    const result = classifyError(new Error("Query execution failed: syntax error"));
    expect(result.exitCode).toBe(ExitCode.QUERY);
  });

  it("should classify SQLCODE errors as QUERY", () => {
    const result = classifyError(new Error("SQLCODE=-204 SQLSTATE=42704"));
    expect(result.exitCode).toBe(ExitCode.QUERY);
  });

  it("should classify connection errors as GENERAL (exit 1)", () => {
    const result = classifyError(new Error("ECONNREFUSED 10.0.0.1:8076"));
    expect(result.exitCode).toBe(ExitCode.GENERAL);
    expect(result.errorCode).toBe(ErrorCode.CONNECTION_ERROR);
  });

  it("should classify timeout errors as GENERAL with CONNECTION_ERROR code", () => {
    const result = classifyError(new Error("Connection timed out"));
    expect(result.exitCode).toBe(ExitCode.GENERAL);
    expect(result.errorCode).toBe(ErrorCode.CONNECTION_ERROR);
  });

  it("should classify not-found errors as GENERAL with NOT_FOUND code", () => {
    const result = classifyError(new Error("Tool 'xyz' not found"));
    expect(result.exitCode).toBe(ExitCode.GENERAL);
    expect(result.errorCode).toBe(ErrorCode.NOT_FOUND);
  });

  it("should classify unknown errors as GENERAL with GENERAL_ERROR code", () => {
    const result = classifyError(new Error("Something unexpected happened"));
    expect(result.exitCode).toBe(ExitCode.GENERAL);
    expect(result.errorCode).toBe(ErrorCode.GENERAL_ERROR);
  });

  it("should always return the original message", () => {
    const msg = "A very specific error message";
    const result = classifyError(new Error(msg));
    expect(result.message).toBe(msg);
  });
});
