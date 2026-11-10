/**
 * @fileoverview What ParameterProcessor binds, and what it refuses to bind:
 * omitted optional parameters, empty arrays, markers without a value and
 * statements that mix marker styles.
 */

import { describe, it, expect } from "vitest";
import { ParameterProcessor } from "../../../../src/ibmi-mcp-server/utils/sql/parameterProcessor.js";
import { SqlToolParameter } from "../../../../src/ibmi-mcp-server/schemas/index.js";

describe("ParameterProcessor - binding", () => {
  describe("omitted optional parameters", () => {
    const sql = "SELECT * FROM T WHERE (:lim IS NULL OR QTY > :lim)";

    it.each(["string", "integer", "float", "boolean", "array"] as const)(
      "binds SQL NULL for an omitted optional %s parameter without a default",
      async (type) => {
        const result = await ParameterProcessor.process(sql, {}, [
          { name: "lim", type, required: false },
        ]);

        expect(result.sql).toBe("SELECT * FROM T WHERE (? IS NULL OR QTY > ?)");
        expect(result.parameters).toEqual([null, null]);
      },
    );

    it("binds SQL NULL for a positional marker as well", async () => {
      const result = await ParameterProcessor.process(
        "SELECT * FROM T WHERE QTY > ?",
        {},
        [{ name: "lim", type: "integer", required: false }],
      );

      expect(result.parameters).toEqual([null]);
    });

    it("binds SQL NULL for an explicit `default: null`", async () => {
      const result = await ParameterProcessor.process(sql, {}, [
        { name: "lim", type: "integer", default: null },
      ]);

      expect(result.parameters).toEqual([null, null]);
    });

    it("binds the default when there is one", async () => {
      const result = await ParameterProcessor.process(sql, {}, [
        { name: "lim", type: "integer", required: false, default: 5 },
      ]);

      expect(result.parameters).toEqual([5, 5]);
    });

    it("still rejects an omitted required parameter", async () => {
      await expect(
        ParameterProcessor.process(sql, {}, [
          { name: "lim", type: "integer", required: true },
        ]),
      ).rejects.toThrow("Parameter 'lim' is required but not provided");
    });
  });

  describe("array parameters", () => {
    const definitions: SqlToolParameter[] = [
      { name: "ids", type: "array", itemType: "integer" },
    ];

    it("rejects an empty array, naming the parameter", async () => {
      await expect(
        ParameterProcessor.process(
          "SELECT * FROM T WHERE ID IN (:ids)",
          { ids: [] },
          definitions,
        ),
      ).rejects.toThrow(
        "Array parameter 'ids' must contain at least one value",
      );
    });
  });

  describe("named markers without a value", () => {
    it("is a validation error instead of SQL that still contains :name", async () => {
      await expect(
        ParameterProcessor.process(
          "SELECT * FROM T WHERE A = :a AND B = :b",
          { a: 1 },
          [{ name: "a", type: "integer" }],
        ),
      ).rejects.toThrow("No value for parameter ':b'");
    });
  });

  describe("mixed marker styles", () => {
    const sql = "SELECT * FROM T WHERE A = :a AND B = ?";

    it("detects a statement that uses both ? and :name", () => {
      expect(ParameterProcessor.mixesMarkerStyles(sql)).toBe(true);
      expect(
        ParameterProcessor.mixesMarkerStyles(
          "SELECT '?' FROM T WHERE A = :a -- why?",
        ),
      ).toBe(false);
      expect(
        ParameterProcessor.mixesMarkerStyles("SELECT * FROM T WHERE A = ?"),
      ).toBe(false);
    });

    it("refuses to bind such a statement", async () => {
      await expect(
        ParameterProcessor.process(sql, { a: 1, b: 2 }, [
          { name: "a", type: "integer" },
        ]),
      ).rejects.toThrow(/mixes named \(:name\) and positional \(\?\)/);
    });
  });
});
