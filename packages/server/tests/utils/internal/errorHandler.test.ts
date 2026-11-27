/**
 * @fileoverview Tests for ErrorHandler error-code classification.
 * @module tests/utils/internal/errorHandler.test
 */

import { describe, it, expect } from "vitest";
import {
  JsonRpcErrorCode,
  McpError,
} from "../../../src/types-global/errors.js";
import { ErrorHandler } from "../../../src/utils/internal/errorHandler.js";

describe("ErrorHandler", () => {
  describe("an error that is already an McpError", () => {
    it.each([
      ["Unauthorized", JsonRpcErrorCode.Unauthorized],
      ["Timeout", JsonRpcErrorCode.Timeout],
      ["ValidationError", JsonRpcErrorCode.ValidationError],
    ])(
      "should stay %s when thrown inside tryCatch with errorCode DatabaseError",
      async (_name, code) => {
        const thrown = new McpError(code, "already classified");

        const caught = await ErrorHandler.tryCatch(
          () => {
            throw thrown;
          },
          {
            operation: "ExecuteQuery",
            errorCode: JsonRpcErrorCode.DatabaseError,
          },
        ).catch((error: unknown) => error);

        expect(caught).toBe(thrown);
        expect((caught as McpError).code).toBe(code);
      },
    );

    it("should keep its code through nested tryCatch layers", async () => {
      const caught = await ErrorHandler.tryCatch(
        () =>
          ErrorHandler.tryCatch(
            () => {
              throw new McpError(JsonRpcErrorCode.Forbidden, "no access");
            },
            {
              operation: "Inner",
              errorCode: JsonRpcErrorCode.DatabaseError,
            },
          ),
        { operation: "Outer", errorCode: JsonRpcErrorCode.InternalError },
      ).catch((error: unknown) => error);

      expect((caught as McpError).code).toBe(JsonRpcErrorCode.Forbidden);
    });
  });

  describe("an unclassified error", () => {
    it("should take options.errorCode", () => {
      const result = ErrorHandler.handleError(new Error("socket closed"), {
        operation: "ExecuteQuery",
        errorCode: JsonRpcErrorCode.DatabaseError,
      });

      expect(result).toBeInstanceOf(McpError);
      expect((result as McpError).code).toBe(JsonRpcErrorCode.DatabaseError);
    });

    it("should be classified from its message when no errorCode is given", () => {
      const result = ErrorHandler.handleError(new Error("request timed out"), {
        operation: "ExecuteQuery",
      });

      expect((result as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    });
  });
});
