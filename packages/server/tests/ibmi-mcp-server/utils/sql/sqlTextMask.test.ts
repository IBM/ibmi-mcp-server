/**
 * @fileoverview Tests for maskSqlLiteralsAndComments.
 */

import { describe, it, expect } from "vitest";
import { maskSqlLiteralsAndComments } from "../../../../src/ibmi-mcp-server/utils/sql/sqlTextMask.js";

const mask = (sql: string) => maskSqlLiteralsAndComments(sql).masked;

/** `sql` with each of `parts` replaced by spaces; line breaks stay. */
const blanked = (sql: string, ...parts: string[]) =>
  parts.reduce(
    (text, part) => text.replace(part, part.replace(/[^\r\n]/g, " ")),
    sql,
  );

describe("maskSqlLiteralsAndComments", () => {
  it("keeps the input length so offsets map to the original text", () => {
    const sql = `SELECT 'a:b', "C:D" /* :x */ FROM T -- :y\nWHERE A = :lib`;
    const masked = mask(sql);
    expect(masked).toHaveLength(sql.length);
    expect(masked.indexOf(":lib")).toBe(sql.indexOf(":lib"));
  });

  it("masks string literals, including '' escapes", () => {
    const sql = `SELECT 'it''s :x', :y FROM T`;
    expect(mask(sql)).toBe(blanked(sql, `'it''s :x'`));
  });

  it('masks delimited identifiers, including "" escapes', () => {
    const sql = `SELECT "A""B:C" FROM T`;
    expect(mask(sql)).toBe(blanked(sql, `"A""B:C"`));
  });

  it("masks line comments and keeps the line break", () => {
    const sql = `SELECT 1 -- the library's :lib\r\nFROM T`;
    expect(mask(sql)).toBe(blanked(sql, `-- the library's :lib\r`));
  });

  it("masks block comments over several lines", () => {
    const sql = `SELECT /* a\n:b */ 1`;
    expect(mask(sql)).toBe(blanked(sql, `/* a\n:b */`));
  });

  it("masks the literal part of prefixed literals such as X'C1'", () => {
    const sql = `SELECT X'C1', G':a' FROM T`;
    expect(mask(sql)).toBe(blanked(sql, `'C1'`, `':a'`));
  });

  it("does not treat quotes inside comments as literals", () => {
    const result = maskSqlLiteralsAndComments(
      `-- the library's tables\nSELECT * FROM T WHERE A = :lib`,
    );
    expect(result.unterminated).toBeUndefined();
    expect(result.masked).toContain(":lib");
  });

  it("does not treat comment markers inside literals as comments", () => {
    expect(mask(`SELECT '--', '/*' FROM T WHERE A = :a`)).toContain(":a");
  });

  it("reports an unclosed single quote", () => {
    expect(maskSqlLiteralsAndComments(`SELECT 'abc FROM T`).unterminated).toBe(
      "single",
    );
  });

  it("reports an unclosed double quote", () => {
    expect(maskSqlLiteralsAndComments(`SELECT "abc FROM T`).unterminated).toBe(
      "double",
    );
  });

  it("masks an unclosed block comment to the end of the text", () => {
    const result = maskSqlLiteralsAndComments(`SELECT 1 /* :x`);
    expect(result.masked).toBe(blanked(`SELECT 1 /* :x`, `/* :x`));
    expect(result.unterminated).toBeUndefined();
  });
});
