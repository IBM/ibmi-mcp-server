import { describe, it, expect } from "vitest";
import {
  ExitCode,
  ErrorCode,
  ToolError,
  UsageError,
  classifyError,
} from "../../src/utils/exit-codes.js";

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
    const result = classifyError(
      new Error("Authentication failed for user QUSER"),
    );
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
    const result = classifyError(
      new Error("System is read-only. Mutation queries are not allowed."),
    );
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
    const result = classifyError(
      new Error("SQL0204 - CUSTMAST in MYLIB not found"),
    );
    expect(result.exitCode).toBe(ExitCode.QUERY);
    expect(result.errorCode).toBe(ErrorCode.SQL_ERROR);
  });

  it("should classify query execution errors as QUERY", () => {
    const result = classifyError(
      new Error("Query execution failed: syntax error"),
    );
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

describe("classifyError — structured information first", () => {
  it("should not treat a table named AUTHORS as an authentication failure", () => {
    // As Mapepire reports it: message, SQLSTATE, SQLCODE
    const withState = classifyError(
      new Error(
        "Error in ExecuteQuery: [SQL0204] AUTHORS in SAMPLE type *FILE not found., 42704, -204",
      ),
    );
    expect(withState.exitCode).toBe(ExitCode.QUERY);
    expect(withState.errorCode).toBe(ErrorCode.SQL_ERROR);

    // Message fallback only
    const withoutState = classifyError(
      new Error("[SQL0204] AUTHORS in SAMPLE type *FILE not found."),
    );
    expect(withoutState.exitCode).toBe(ExitCode.QUERY);
    expect(withoutState.errorCode).toBe(ErrorCode.SQL_ERROR);
  });

  it("should not treat a column named PASSWORD as an authentication failure", () => {
    const result = classifyError(
      new Error(
        "[SQL0206] Column or global variable PASSWORD not found., 42703, -206",
      ),
    );
    expect(result.exitCode).toBe(ExitCode.QUERY);
  });

  it("should classify by SQLSTATE class: 28 is AUTH, 08 is a connection error", () => {
    const auth = classifyError(
      new Error("Authorization failure on connection attempt., 28000, -30082"),
    );
    expect(auth.exitCode).toBe(ExitCode.AUTH);
    expect(auth.errorCode).toBe(ErrorCode.AUTH_FAILURE);

    const connection = classifyError(
      new Error("The SQL query could not reach the database., 08001, -30080"),
    );
    expect(connection.exitCode).toBe(ExitCode.GENERAL);
    expect(connection.errorCode).toBe(ErrorCode.CONNECTION_ERROR);
  });

  it("should classify UsageError as USAGE (exit 2) whatever the message says", () => {
    const result = classifyError(
      new UsageError("System(s) [prod] require confirmation. Pass --yes."),
    );
    expect(result.exitCode).toBe(ExitCode.USAGE);
    expect(result.errorCode).toBe(ErrorCode.USAGE_ERROR);
  });

  it("should classify by the server's error code carried on a ToolError", () => {
    // -32006 Unauthorized
    const auth = classifyError(
      new ToolError({ code: "-32006", message: "Rejected" }, "failed"),
    );
    expect(auth.exitCode).toBe(ExitCode.AUTH);
    expect(auth.errorCode).toBe(ErrorCode.AUTH_FAILURE);

    // -32005 Forbidden
    const security = classifyError(
      new ToolError({ code: "-32005", message: "Rejected" }, "failed"),
    );
    expect(security.exitCode).toBe(ExitCode.SECURITY);

    // -32007 ValidationError is a security violation only when the SQL
    // security validators raised it (they attach the violations)
    const writeBlocked = classifyError(
      new ToolError(
        {
          code: "-32007",
          message:
            "Write operations detected: Write operation detected: Delete",
          details: { violations: ["Write operation detected: Delete"] },
        },
        "failed",
      ),
    );
    expect(writeBlocked.exitCode).toBe(ExitCode.SECURITY);
    expect(writeBlocked.errorCode).toBe(ErrorCode.SECURITY_VIOLATION);

    const badParameter = classifyError(
      new ToolError(
        { code: "-32007", message: "Parameter 'limit' is out of range" },
        "failed",
      ),
    );
    expect(badParameter.exitCode).toBe(ExitCode.GENERAL);

    // -32009 InitializationFailed: the pool could not be opened
    const connection = classifyError(
      new ToolError({ code: "-32009", message: "Something broke" }, "failed"),
    );
    expect(connection.errorCode).toBe(ErrorCode.CONNECTION_ERROR);

    // -32010 DatabaseError with nothing else to go on
    const database = classifyError(
      new ToolError({ code: "-32010", message: "Something broke" }, "failed"),
    );
    expect(database.exitCode).toBe(ExitCode.QUERY);
    expect(database.errorCode).toBe(ErrorCode.SQL_ERROR);
  });

  it("should use the fallback message when a tool reports no error", () => {
    const error = new ToolError(undefined, "Failed to list schemas");
    expect(error.message).toBe("Failed to list schemas");
    expect(error.code).toBeUndefined();
  });

  it("should classify by a Node.js network or TLS code on the error's cause", () => {
    const tls = Object.assign(
      new Error("self-signed certificate in certificate chain"),
      { code: "SELF_SIGNED_CERT_IN_CHAIN" },
    );
    // The server pool wraps driver errors and keeps the original as `cause`
    const wrapped = Object.assign(
      new Error("Error in performInitialization: failed", { cause: tls }),
      { code: -32010 },
    );
    const result = classifyError(wrapped);
    expect(result.exitCode).toBe(ExitCode.GENERAL);
    expect(result.errorCode).toBe(ErrorCode.CONNECTION_ERROR);

    const refused = classifyError(
      Object.assign(new Error("failed"), { code: "ECONNREFUSED" }),
    );
    expect(refused.errorCode).toBe(ErrorCode.CONNECTION_ERROR);
  });
});
