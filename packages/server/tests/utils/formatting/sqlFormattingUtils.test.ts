/**
 * @fileoverview Tests for SQL formatting utilities
 * Tests the header formatting function
 * @module tests/utils/formatting/sqlFormattingUtils
 */

import { describe, it, expect } from "vitest";
import { formatColumnHeader } from "../../../src/utils/formatting/sqlFormattingUtils.js";

describe("SQL Formatting Utilities", () => {
  describe("formatColumnHeader", () => {
    it("should format header with type", () => {
      expect(formatColumnHeader("EMPLOYEE_ID", "INTEGER")).toBe(
        "EMPLOYEE_ID (INTEGER)",
      );
      expect(formatColumnHeader("NAME", "VARCHAR(50)")).toBe("NAME (VARCHAR)");
      expect(formatColumnHeader("SALARY", "DECIMAL(10,2)")).toBe(
        "SALARY (DECIMAL)",
      );
    });

    it("should handle lowercase types", () => {
      expect(formatColumnHeader("id", "integer")).toBe("id (INTEGER)");
      expect(formatColumnHeader("name", "varchar(100)")).toBe("name (VARCHAR)");
    });

    it("should return just name when no type provided", () => {
      expect(formatColumnHeader("COLUMN_NAME")).toBe("COLUMN_NAME");
      expect(formatColumnHeader("col", undefined)).toBe("col");
    });

    it("should extract base type without precision", () => {
      expect(formatColumnHeader("AMT", "DECIMAL(15,2)")).toBe("AMT (DECIMAL)");
      expect(formatColumnHeader("CODE", "CHAR(10)")).toBe("CODE (CHAR)");
      expect(formatColumnHeader("TS", "TIMESTAMP(6)")).toBe("TS (TIMESTAMP)");
    });

    it("should handle types with extra whitespace", () => {
      expect(formatColumnHeader("COL", "  VARCHAR(50)  ")).toBe(
        "COL (VARCHAR)",
      );
      expect(formatColumnHeader("NUM", "  INTEGER  ")).toBe("NUM (INTEGER)");
    });

    it("should handle complex column names", () => {
      expect(formatColumnHeader("EMPLOYEE_FIRST_NAME", "VARCHAR")).toBe(
        "EMPLOYEE_FIRST_NAME (VARCHAR)",
      );
      expect(formatColumnHeader("AVG_SALARY_USD", "DECIMAL")).toBe(
        "AVG_SALARY_USD (DECIMAL)",
      );
    });
  });
});
