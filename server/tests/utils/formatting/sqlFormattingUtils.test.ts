/**
 * @fileoverview Tests for SQL formatting utilities
 * Tests column type alignment and header formatting functions
 * @module tests/utils/formatting/sqlFormattingUtils
 */

import { describe, it, expect } from "vitest";
import {
  getColumnAlignment,
  formatColumnHeader,
  buildColumnAlignmentMap,
} from "../../../src/utils/formatting/sqlFormattingUtils.js";

describe("SQL Formatting Utilities", () => {
  describe("getColumnAlignment", () => {
    describe("Numeric types (right-aligned)", () => {
      it("should right-align INTEGER", () => {
        expect(getColumnAlignment("INTEGER")).toBe("right");
        expect(getColumnAlignment("integer")).toBe("right");
        expect(getColumnAlignment("INT")).toBe("right");
      });

      it("should right-align SMALLINT", () => {
        expect(getColumnAlignment("SMALLINT")).toBe("right");
        expect(getColumnAlignment("smallint")).toBe("right");
      });

      it("should right-align BIGINT", () => {
        expect(getColumnAlignment("BIGINT")).toBe("right");
        expect(getColumnAlignment("bigint")).toBe("right");
      });

      it("should right-align DECIMAL and NUMERIC", () => {
        expect(getColumnAlignment("DECIMAL")).toBe("right");
        expect(getColumnAlignment("NUMERIC")).toBe("right");
        expect(getColumnAlignment("DEC")).toBe("right");
        expect(getColumnAlignment("decimal")).toBe("right");
      });

      it("should right-align floating point types", () => {
        expect(getColumnAlignment("FLOAT")).toBe("right");
        expect(getColumnAlignment("REAL")).toBe("right");
        expect(getColumnAlignment("DOUBLE")).toBe("right");
        expect(getColumnAlignment("DECFLOAT")).toBe("right");
      });

      it("should handle types with precision/scale", () => {
        expect(getColumnAlignment("DECIMAL(10,2)")).toBe("right");
        expect(getColumnAlignment("NUMERIC(15,4)")).toBe("right");
        expect(getColumnAlignment("FLOAT(53)")).toBe("right");
      });
    });

    describe("Text types (left-aligned)", () => {
      it("should left-align VARCHAR", () => {
        expect(getColumnAlignment("VARCHAR")).toBe("left");
        expect(getColumnAlignment("varchar")).toBe("left");
      });

      it("should left-align CHAR", () => {
        expect(getColumnAlignment("CHAR")).toBe("left");
        expect(getColumnAlignment("CHARACTER")).toBe("left");
        expect(getColumnAlignment("char")).toBe("left");
      });

      it("should left-align LOB types", () => {
        expect(getColumnAlignment("CLOB")).toBe("left");
        expect(getColumnAlignment("BLOB")).toBe("left");
        expect(getColumnAlignment("DBCLOB")).toBe("left");
      });

      it("should left-align graphic types", () => {
        expect(getColumnAlignment("VARGRAPHIC")).toBe("left");
        expect(getColumnAlignment("GRAPHIC")).toBe("left");
      });

      it("should left-align binary types", () => {
        expect(getColumnAlignment("BINARY")).toBe("left");
        expect(getColumnAlignment("VARBINARY")).toBe("left");
      });

      it("should handle types with length", () => {
        expect(getColumnAlignment("VARCHAR(100)")).toBe("left");
        expect(getColumnAlignment("CHAR(10)")).toBe("left");
        expect(getColumnAlignment("VARGRAPHIC(50)")).toBe("left");
      });
    });

    describe("Temporal types (left-aligned)", () => {
      it("should left-align DATE", () => {
        expect(getColumnAlignment("DATE")).toBe("left");
        expect(getColumnAlignment("date")).toBe("left");
      });

      it("should left-align TIME", () => {
        expect(getColumnAlignment("TIME")).toBe("left");
        expect(getColumnAlignment("time")).toBe("left");
      });

      it("should left-align TIMESTAMP", () => {
        expect(getColumnAlignment("TIMESTAMP")).toBe("left");
        expect(getColumnAlignment("TIMESTMP")).toBe("left");
        expect(getColumnAlignment("timestamp")).toBe("left");
      });

      it("should handle types with precision", () => {
        expect(getColumnAlignment("TIMESTAMP(6)")).toBe("left");
        expect(getColumnAlignment("TIME(0)")).toBe("left");
      });
    });

    describe("Edge cases", () => {
      it("should handle undefined type", () => {
        expect(getColumnAlignment(undefined)).toBe("left");
      });

      it("should handle empty string", () => {
        expect(getColumnAlignment("")).toBe("left");
      });

      it("should handle unknown types", () => {
        expect(getColumnAlignment("UNKNOWN_TYPE")).toBe("left");
        expect(getColumnAlignment("CUSTOM_TYPE")).toBe("left");
      });

      it("should handle types with extra whitespace", () => {
        expect(getColumnAlignment("  INTEGER  ")).toBe("right");
        expect(getColumnAlignment("  VARCHAR(50)  ")).toBe("left");
      });

      it("should handle mixed case", () => {
        expect(getColumnAlignment("InTeGeR")).toBe("right");
        expect(getColumnAlignment("VaRcHaR")).toBe("left");
      });
    });
  });

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

  describe("buildColumnAlignmentMap", () => {
    it("should build alignment map for typical SQL columns", () => {
      const columns = [
        { name: "EMPLOYEE_ID", type: "INTEGER" },
        { name: "FIRST_NAME", type: "VARCHAR(50)" },
        { name: "LAST_NAME", type: "VARCHAR(50)" },
        { name: "SALARY", type: "DECIMAL(10,2)" },
        { name: "HIRE_DATE", type: "DATE" },
        { name: "IS_ACTIVE", type: "INTEGER" },
      ];

      const alignmentMap = buildColumnAlignmentMap(columns);

      expect(alignmentMap).toEqual({
        EMPLOYEE_ID: "right",
        FIRST_NAME: "left",
        LAST_NAME: "left",
        SALARY: "right",
        HIRE_DATE: "left",
        IS_ACTIVE: "right",
      });
    });

    it("should handle columns without types", () => {
      const columns = [
        { name: "COL1" },
        { name: "COL2", type: "INTEGER" },
        { name: "COL3", type: undefined },
      ];

      const alignmentMap = buildColumnAlignmentMap(columns);

      expect(alignmentMap).toEqual({
        COL1: "left", // Default for undefined
        COL2: "right",
        COL3: "left", // Default for undefined
      });
    });

    it("should handle empty column array", () => {
      const alignmentMap = buildColumnAlignmentMap([]);
      expect(alignmentMap).toEqual({});
    });

    it("should handle mixed numeric and text types", () => {
      const columns = [
        { name: "ID", type: "BIGINT" },
        { name: "CODE", type: "CHAR(10)" },
        { name: "AMOUNT", type: "FLOAT" },
        { name: "DESCRIPTION", type: "CLOB" },
        { name: "QUANTITY", type: "SMALLINT" },
      ];

      const alignmentMap = buildColumnAlignmentMap(columns);

      expect(alignmentMap).toEqual({
        ID: "right",
        CODE: "left",
        AMOUNT: "right",
        DESCRIPTION: "left",
        QUANTITY: "right",
      });
    });

    it("should handle real IBM i column definitions", () => {
      const columns = [
        { name: "ORDNUM", type: "DECIMAL(9,0)" },
        { name: "CUSTNUM", type: "DECIMAL(9,0)" },
        { name: "CUSTNAME", type: "VARCHAR(50)" },
        { name: "ORDDATE", type: "DATE" },
        { name: "ORDAMT", type: "DECIMAL(15,2)" },
        { name: "STATUS", type: "CHAR(1)" },
        { name: "SHIPDATE", type: "TIMESTAMP" },
      ];

      const alignmentMap = buildColumnAlignmentMap(columns);

      expect(alignmentMap).toEqual({
        ORDNUM: "right",
        CUSTNUM: "right",
        CUSTNAME: "left",
        ORDDATE: "left",
        ORDAMT: "right",
        STATUS: "left",
        SHIPDATE: "left",
      });
    });
  });

  describe("Integration scenarios", () => {
    it("should handle complete SQL result column metadata", () => {
      // Simulating actual column metadata from IBM i DB2
      const columns = [
        { name: "EMPLOYEE_NUMBER", type: "DECIMAL(7,0)" },
        { name: "LASTNAME", type: "VARCHAR(15)" },
        { name: "WORKDEPT", type: "CHAR(3)" },
        { name: "PHONENO", type: "CHAR(4)" },
        { name: "HIREDATE", type: "DATE" },
        { name: "EDLEVEL", type: "SMALLINT" },
        { name: "SALARY", type: "DECIMAL(9,2)" },
        { name: "BONUS", type: "DECIMAL(9,2)" },
        { name: "COMM", type: "DECIMAL(9,2)" },
      ];

      // Build alignment map
      const alignmentMap = buildColumnAlignmentMap(columns);

      // Format headers
      const headers = columns.map((col) =>
        formatColumnHeader(col.name, col.type),
      );

      // Verify alignment
      expect(alignmentMap.EMPLOYEE_NUMBER).toBe("right");
      expect(alignmentMap.LASTNAME).toBe("left");
      expect(alignmentMap.SALARY).toBe("right");
      expect(alignmentMap.HIREDATE).toBe("left");

      // Verify headers
      expect(headers).toContain("EMPLOYEE_NUMBER (DECIMAL)");
      expect(headers).toContain("LASTNAME (VARCHAR)");
      expect(headers).toContain("SALARY (DECIMAL)");
      expect(headers).toContain("HIREDATE (DATE)");
    });
  });
});
