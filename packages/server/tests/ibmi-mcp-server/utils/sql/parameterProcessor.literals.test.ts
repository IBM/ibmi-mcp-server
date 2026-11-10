/**
 * @fileoverview ParameterProcessor must not find parameter markers or
 * syntax errors inside string literals, delimited identifiers or comments.
 * Covers #207 and #208.
 */

import { describe, it, expect } from "vitest";
import { ParameterProcessor } from "../../../../src/ibmi-mcp-server/utils/sql/parameterProcessor.js";
import { SqlToolParameter } from "../../../../src/ibmi-mcp-server/schemas/index.js";

const libParam: SqlToolParameter[] = [{ name: "lib", type: "string" }];

describe("ParameterProcessor - literals and comments", () => {
  describe("named parameters (#207)", () => {
    it("ignores :word inside a time format literal", async () => {
      const result = await ParameterProcessor.process(
        `SELECT VARCHAR_FORMAT(CURRENT TIMESTAMP, 'HH24:MI:SS') AS NOW_TIME
           FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = :lib`,
        { lib: "QSYS2" },
        libParam,
      );

      expect(result.sql).toContain(`'HH24:MI:SS'`);
      expect(result.parameters).toEqual(["QSYS2"]);
      expect(result.parameterNames).toEqual(["lib"]);
      expect(result.missingParameters).toEqual([]);
    });

    it("does not replace a parameter name that appears in a comment", async () => {
      const sql = `SELECT TABLE_NAME -- filter on :lib
           FROM QSYS2.SYSTABLES /* :lib again */ WHERE TABLE_SCHEMA = :lib`;
      const result = await ParameterProcessor.process(
        sql,
        { lib: "QSYS2" },
        libParam,
      );

      expect(result.sql).toContain("-- filter on :lib");
      expect(result.sql).toContain("/* :lib again */");
      expect(result.sql).toMatch(/TABLE_SCHEMA = \?$/);
      expect(result.parameters).toEqual(["QSYS2"]);
    });

    it("does not replace a parameter name inside a literal or delimited identifier", async () => {
      const result = await ParameterProcessor.process(
        `SELECT ':lib' AS "x:lib" FROM T WHERE A = :lib`,
        { lib: "QSYS2" },
        libParam,
      );

      expect(result.sql).toBe(`SELECT ':lib' AS "x:lib" FROM T WHERE A = ?`);
      expect(result.parameters).toEqual(["QSYS2"]);
    });

    it("still expands array parameters after a literal", async () => {
      const result = await ParameterProcessor.process(
        `SELECT 'a:b' FROM T WHERE A IN (:libs)`,
        { libs: ["X", "Y"] },
        [{ name: "libs", type: "array", itemType: "string" }],
      );

      expect(result.sql).toBe(`SELECT 'a:b' FROM T WHERE A IN (?, ?)`);
      expect(result.parameters).toEqual(["X", "Y"]);
    });

    it("does not list names from literals or comments", () => {
      expect(
        ParameterProcessor.extractParameterNames(
          `SELECT 'HH24:MI' FROM T -- :old\nWHERE A = :lib`,
        ),
      ).toEqual(["lib"]);
    });
  });

  describe("positional parameters", () => {
    it("does not count ? inside a literal or comment", async () => {
      const sql = `SELECT '?' FROM T /* ? */ WHERE A = ?`;
      expect(ParameterProcessor.countPositionalParameters(sql)).toBe(1);

      const result = await ParameterProcessor.process(sql, { 0: "X" });
      expect(result.parameters).toEqual(["X"]);
      expect(result.stats.positionalParametersFound).toBe(1);
    });
  });

  describe("syntax pre-checks (#208)", () => {
    it("accepts an apostrophe in a line comment", async () => {
      const result = await ParameterProcessor.process(
        `-- returns the library's tables
         SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = :lib`,
        { lib: "QSYS2" },
        libParam,
      );
      expect(result.parameters).toEqual(["QSYS2"]);
    });

    it("accepts :digit inside a time literal", async () => {
      const result = await ParameterProcessor.process(
        `SELECT * FROM QSYS2.SYSTABLES
          WHERE TABLE_SCHEMA = :lib
            AND LAST_ALTERED_TIMESTAMP > TIMESTAMP(CURRENT DATE, '10:30:00')`,
        { lib: "QSYS2" },
        libParam,
      );
      expect(result.parameters).toEqual(["QSYS2"]);
    });

    it("accepts an escaped quote in a literal", async () => {
      const result = await ParameterProcessor.process(
        `SELECT 'it''s' FROM T WHERE A = :lib`,
        { lib: "QSYS2" },
        libParam,
      );
      expect(result.parameters).toEqual(["QSYS2"]);
    });

    it("still rejects :digit in code", async () => {
      await expect(
        ParameterProcessor.process(`SELECT * FROM T WHERE A = :3`, {}),
      ).rejects.toThrow(/Invalid named parameter syntax found: :3/);
    });

    it("still rejects an unclosed single quote", async () => {
      await expect(
        ParameterProcessor.process(`SELECT 'abc FROM T WHERE A = :lib`, {
          lib: "X",
        }),
      ).rejects.toThrow(/Unmatched single quotes/);
    });

    it("still rejects an unclosed double quote", async () => {
      await expect(
        ParameterProcessor.process(`SELECT "abc FROM T WHERE A = :lib`, {
          lib: "X",
        }),
      ).rejects.toThrow(/Unmatched double quotes/);
    });
  });
});
