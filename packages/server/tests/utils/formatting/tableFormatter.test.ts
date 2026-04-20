/**
 * @fileoverview Integration tests for TableFormatter with NULL handling
 * Tests the complete formatting pipeline with real data structures
 * @module tests/utils/formatting/tableFormatter
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  tableFormatter,
  TableFormatter,
} from "../../../src/utils/formatting/tableFormatter.js";

describe("TableFormatter - NULL Handling", () => {
  let formatter: TableFormatter;

  beforeEach(() => {
    formatter = new TableFormatter();
  });

  describe("formatWithMetadata", () => {
    it("should track NULL values in object arrays", () => {
      const data = [
        { id: 1, name: "Alice", salary: 50000 },
        { id: 2, name: "Bob", salary: null },
        { id: 3, name: null, salary: 60000 },
        { id: 4, name: "Diana", salary: null },
      ];

      const result = formatter.formatWithMetadata(data);

      // Should have formatted table
      expect(result.table).toBeTruthy();
      expect(result.table).toContain("Alice");
      expect(result.table).toContain("Bob");

      // Should track NULL counts by column name
      expect(result.metadata.nullCounts).toEqual({
        name: 1,
        salary: 2,
      });
    });

    it("should replace NULL values with default replacement", () => {
      const data = [
        { id: 1, value: null },
        { id: 2, value: "test" },
      ];

      const result = formatter.formatWithMetadata(data);

      // Default NULL replacement is '-'
      expect(result.table).toContain("-");
      expect(result.table).toContain("test");
      expect(result.metadata.nullCounts).toEqual({ value: 1 });
    });

    it("should use custom NULL replacement", () => {
      const data = [
        { id: 1, value: null },
        { id: 2, value: "test" },
      ];

      const result = formatter.formatWithMetadata(data, {
        nullReplacement: "N/A",
      });

      expect(result.table).toContain("N/A");
      // Check that actual NULL values were replaced (not just table separators)
      expect(result.table).toMatch(/\|\s+\d+\s+\|\s+N\/A\s+\|/);
      expect(result.metadata.nullCounts).toEqual({ value: 1 });
    });

    it("should handle empty arrays", () => {
      const result = formatter.formatWithMetadata([]);

      expect(result.table).toBe("");
      expect(result.metadata.nullCounts).toEqual({});
    });

    it("should handle arrays with no NULLs", () => {
      const data = [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ];

      const result = formatter.formatWithMetadata(data);

      expect(result.table).toBeTruthy();
      expect(result.metadata.nullCounts).toEqual({});
    });

    it("should work with different table styles", () => {
      const data = [
        { id: 1, value: null },
        { id: 2, value: "test" },
      ];

      // Test markdown style
      const mdResult = formatter.formatWithMetadata(data, {
        style: "markdown",
      });
      expect(mdResult.table).toContain("|");
      expect(mdResult.metadata.nullCounts).toEqual({ value: 1 });

      // Test grid style
      const gridResult = formatter.formatWithMetadata(data, { style: "grid" });
      expect(gridResult.table).toContain("│");
      expect(gridResult.metadata.nullCounts).toEqual({ value: 1 });

      // Test ascii style
      const asciiResult = formatter.formatWithMetadata(data, {
        style: "ascii",
      });
      expect(asciiResult.table).toContain("+");
      expect(asciiResult.metadata.nullCounts).toEqual({ value: 1 });
    });
  });

  describe("formatRawWithMetadata", () => {
    it("should track NULL values in raw arrays", () => {
      const headers = ["ID", "Name", "Salary"];
      const rows: (string | null)[][] = [
        ["1", "Alice", "50000"],
        ["2", "Bob", null],
        ["3", null, "60000"],
        ["4", "Diana", null],
      ];

      const result = formatter.formatRawWithMetadata(headers, rows);

      expect(result.table).toBeTruthy();
      expect(result.table).toContain("Alice");

      // NULL counts indexed by column position
      expect(result.metadata.nullCounts).toEqual({
        "1": 1, // Name column (index 1)
        "2": 2, // Salary column (index 2)
      });
    });

    it("should handle undefined values", () => {
      const headers = ["A", "B", "C"];
      const rows: (string | undefined)[][] = [
        ["1", undefined, "3"],
        ["4", "5", undefined],
      ];

      const result = formatter.formatRawWithMetadata(headers, rows);

      expect(result.table).toContain("-");
      expect(result.metadata.nullCounts).toEqual({
        "1": 1,
        "2": 1,
      });
    });

    it("should handle mixed null and undefined", () => {
      const headers = ["Col1", "Col2"];
      const rows: (string | null | undefined)[][] = [
        [null, "value"],
        [undefined, "value"],
        ["value", null],
      ];

      const result = formatter.formatRawWithMetadata(headers, rows);

      expect(result.metadata.nullCounts).toEqual({
        "0": 2, // Both null and undefined counted
        "1": 1,
      });
    });

    it("should validate headers and rows", () => {
      expect(() => {
        formatter.formatRawWithMetadata([], [["data"]]);
      }).toThrow("Headers must be a non-empty array");

      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formatter.formatRawWithMetadata(["header"], null as any);
      }).toThrow("Rows must be an array");
    });
  });

  describe("Backward compatibility", () => {
    it("should maintain original format() behavior", () => {
      const data = [
        { id: 1, name: "Alice", salary: null },
        { id: 2, name: "Bob", salary: 50000 },
      ];

      // Original method should still work
      const result = formatter.format(data);

      expect(result).toBeTruthy();
      expect(result).toContain("Alice");
      expect(result).toContain("Bob");
      expect(result).toContain("-"); // NULL replacement
    });

    it("should maintain original formatRaw() behavior", () => {
      const headers = ["ID", "Name"];
      const rows: string[][] = [
        ["1", "-"], // formatRaw expects strings, not nulls
        ["2", "Bob"],
      ];

      // Original method should still work
      const result = formatter.formatRaw(headers, rows);

      expect(result).toBeTruthy();
      expect(result).toContain("Bob");
      expect(result).toContain("-");
    });
  });

  describe("Column alignment with NULLs", () => {
    it("should properly align NULL replacements", () => {
      const data = [
        { id: 1, amount: 1000 },
        { id: 2, amount: null },
        { id: 3, amount: 50 },
      ];

      const result = formatter.formatWithMetadata(data, {
        alignment: { amount: "right" },
        style: "markdown",
      });

      // Check that table is formatted
      expect(result.table).toBeTruthy();
      expect(result.table).toContain("1000");
      expect(result.table).toContain("-");
      expect(result.metadata.nullCounts).toEqual({ amount: 1 });
    });
  });

  describe("Integration with truncation", () => {
    it("should handle NULLs with truncation enabled", () => {
      const data = [
        { id: 1, description: null },
        {
          id: 2,
          description: "A very long description that will be truncated",
        },
      ];

      const result = formatter.formatWithMetadata(data, {
        maxWidth: 20,
        truncate: true,
      });

      expect(result.table).toContain("-");
      expect(result.table).toContain("...");
      expect(result.metadata.nullCounts).toEqual({ description: 1 });
    });
  });

  describe("Singleton instance", () => {
    it("should work with singleton tableFormatter", () => {
      const data = [
        { col1: "value", col2: null },
        { col1: null, col2: "value" },
      ];

      const result = tableFormatter.formatWithMetadata(data);

      expect(result.table).toBeTruthy();
      expect(result.metadata.nullCounts).toEqual({
        col1: 1,
        col2: 1,
      });
    });
  });

  describe("Real-world SQL result simulation", () => {
    it("should handle typical database result set with NULLs", () => {
      const sqlData = [
        {
          EMPLOYEE_ID: 1001,
          FIRST_NAME: "John",
          LAST_NAME: "Doe",
          EMAIL: "john.doe@example.com",
          PHONE: null,
          DEPARTMENT: "Engineering",
          SALARY: 75000,
          MANAGER_ID: null,
        },
        {
          EMPLOYEE_ID: 1002,
          FIRST_NAME: "Jane",
          LAST_NAME: "Smith",
          EMAIL: null,
          PHONE: "555-0100",
          DEPARTMENT: "Sales",
          SALARY: 65000,
          MANAGER_ID: 2001,
        },
        {
          EMPLOYEE_ID: 1003,
          FIRST_NAME: "Bob",
          LAST_NAME: "Johnson",
          EMAIL: "bob.j@example.com",
          PHONE: null,
          DEPARTMENT: null,
          SALARY: null,
          MANAGER_ID: 2001,
        },
      ];

      const result = tableFormatter.formatWithMetadata(sqlData, {
        alignment: {
          EMPLOYEE_ID: "right",
          SALARY: "right",
          MANAGER_ID: "right",
        },
      });

      // Verify table generation
      expect(result.table).toContain("John");
      expect(result.table).toContain("Jane");
      expect(result.table).toContain("Bob");

      // Verify NULL tracking
      expect(result.metadata.nullCounts).toEqual({
        PHONE: 2,
        EMAIL: 1,
        DEPARTMENT: 1,
        SALARY: 1,
        MANAGER_ID: 1,
      });

      // Verify structure
      expect(result.table).toContain("EMPLOYEE_ID");
      expect(result.table).toContain("FIRST_NAME");
    });
  });
});
