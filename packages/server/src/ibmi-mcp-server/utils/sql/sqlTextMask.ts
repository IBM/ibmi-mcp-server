/**
 * @fileoverview Masks SQL string literals, delimited identifiers and comments
 * so that parameter markers can be found with simple patterns.
 *
 * The vendored SQL tokeniser in `utils/language/` drops comment text and
 * reports shifted ranges for prefixed literals such as `X'C1'`, so it cannot
 * map a match back to an exact offset. This scanner keeps the input length:
 * offset N in the masked text is offset N in the original text.
 *
 * @module src/ibmi-mcp-server/utils/sql/sqlTextMask
 */

/** A quote that opens but does not close before the end of the statement. */
export type UnterminatedQuote = "single" | "double";

export interface MaskedSql {
  /**
   * Same length as the input. Every character inside a `'...'` literal, a
   * `"..."` delimited identifier, a `--` line comment or a `/* *\/` block
   * comment is a space. Line breaks stay, so line numbers do not change.
   */
  masked: string;
  /** Set when a literal or delimited identifier is not closed. */
  unterminated?: UnterminatedQuote;
}

/**
 * Masks the parts of a SQL statement that cannot hold a parameter marker.
 *
 * Quotes are masked with their content. A doubled quote (`''` or `""`)
 * inside a literal or identifier is an escape and does not close it.
 */
export function maskSqlLiteralsAndComments(sql: string): MaskedSql {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
    }
  };

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      let end = sql.indexOf("\n", i);
      if (end < 0) end = sql.length;
      blank(i, end);
      i = end;
    } else if (ch === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close < 0 ? sql.length : close + 2;
      blank(i, end);
      i = end;
    } else if (ch === "'" || ch === '"') {
      const end = closingQuote(sql, i);
      if (end < 0) {
        blank(i, sql.length);
        return {
          masked: out.join(""),
          unterminated: ch === "'" ? "single" : "double",
        };
      }
      blank(i, end + 1);
      i = end + 1;
    } else {
      i++;
    }
  }

  return { masked: out.join("") };
}

/** Index of the quote that closes the one at `start`, or -1. */
function closingQuote(sql: string, start: number): number {
  const quote = sql[start];
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}
