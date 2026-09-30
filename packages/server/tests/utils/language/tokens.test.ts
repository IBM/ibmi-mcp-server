import { describe, expect, test } from "vitest";
import SQLTokeniser from "../../../src/ibmi-mcp-server/utils/language/tokens";
import Document from "../../../src/ibmi-mcp-server/utils/language/document";

// Edit an assertion and save to see HMR in action

test("Basic tokens", () => {
  const tokeniser = new SQLTokeniser();

  const tokens = tokeniser.tokenise(`select * from sample`);

  expect(tokens.length).toBe(4);
});

test("Function and block test", () => {
  const tokeniser = new SQLTokeniser();

  const tokens = tokeniser.tokenise(`select * from table(func()) x`);

  expect(tokens.length).toBe(10);
});

test("Comment test", () => {
  const tokeniser = new SQLTokeniser();

  const tokens = tokeniser.tokenise(
    `select * from table(func()) x -- Hello world`,
  );

  expect(tokens.length).toBe(10);
});

test("Comment token test", () => {
  const tokeniser = new SQLTokeniser();
  tokeniser.storeComments = true;

  const tokens = tokeniser.tokenise(
    [`--hello: world!!!: coolness`, `select * from table(func()) x`].join(`\n`),
  );

  expect(tokens.length).toBe(12);
  expect(
    tokens.some((t) => t.value === `--hello: world!!!: coolness`),
  ).toBeTruthy();
});

test("New line (\\n) and comments test", () => {
  const tokeniser = new SQLTokeniser();

  const tokens = tokeniser.tokenise(
    [`select * --cool`, `from sample -- this table doesn't exist`].join(`\n`),
  );

  expect(tokens.length).toBe(5);
  expect(tokens[2].type).toBe(`newline`);
});

test("New line (\\r\\n) and comments test", () => {
  const tokeniser = new SQLTokeniser();

  const tokens = tokeniser.tokenise(
    [`select * --cool`, `from sample-- this table doesn't exist`].join(`\r\n`),
  );

  expect(tokens.length).toBe(5);
  expect(tokens[2].type).toBe(`newline`);
});

test(`Delimited names`, () => {
  const tokeniser = new SQLTokeniser();
  const line = `CREATE TABLE "TestDelimiters"."Delimited Table" ("Delimited Column" INTEGER DEFAULT NULL, CONSTRAINT "TestDelimiters"."Delimited Key" PRIMARY KEY ("Delimited Column"));`;

  const tokens = tokeniser.tokenise(line);

  expect(tokens.length).toBe(22);

  expect(tokens[2].type).toBe(`sqlName`);
  expect(tokens[2].value).toBe(`"TestDelimiters"`);

  expect(tokens[3].type).toBe(`dot`);

  expect(tokens[4].type).toBe(`sqlName`);
  expect(tokens[4].value).toBe(`"Delimited Table"`);
});

test(`Block comments`, () => {
  const lines = [
    `/*%METADATA                                                     */`,
    `/* %TEXT                                                        */`,
    `/*%EMETADATA                                                    */`,
    ``,
    `Create Trigger ORD701_Insert_order`,
    `After Insert  on order`,
    `Referencing  New As N`,
    ``,
    `For Each Row`,
    `Program Name ORD701`,
    `set option sqlPath = *LIBL`,
    `Begin`,
    ``,
    `  Update Customer set culastord = n.ordate`,
    `         where cuid = N.orcuid;`,
    `End`,
  ].join(` `);

  const tokeniser = new SQLTokeniser();
  const tokens = tokeniser.tokenise(lines);

  expect(tokens[0].type).toBe(`statementType`);
  expect(tokens[0].value).toBe(`Create`);
  expect(lines.substring(tokens[0].range.start, tokens[0].range.end)).toBe(
    `Create`,
  );
});

test("For in data-type (issue #315)", () => {
  const tokeniser = new SQLTokeniser();

  const tokens = tokeniser.tokenise(
    [
      `select cast(x'01' as char(1) for bit data) as something,`,
      `case when 1=1 then 'makes sense' else 'what?' end as something_else`,
      `from sysibm.sysdummy1;`,
    ].join(`\n`),
  );

  expect(tokens.length).toBe(35);
  expect(tokens[9].type).toBe(`word`);
  expect(tokens[9].value?.toLowerCase()).toBe(`for`);
});

// Db2 for i lexing fidelity (verified live on IBM i 7.4). The execute_sql
// guardrails depend on the tokenizer splitting text the way Db2 does.
describe("Db2 for i lexing fidelity", () => {
  const values = (sql: string) =>
    new SQLTokeniser()
      .tokenise(sql)
      .filter((t) => t.type !== `newline` && t.type !== `newliner`)
      .map((t) => t.value);

  test("a block comment ends the pending word", () => {
    expect(values(`INSERT/*x*/INTO`)).toEqual([`INSERT`, `INTO`]);
    expect(values(`FINAL/*x*/TABLE`)).toEqual([`FINAL`, `TABLE`]);
  });

  test("block comments nest", () => {
    expect(values(`SELECT /* a /* b */ c */ 1`)).toEqual([`SELECT`, `1`]);
    // Unnested reading would expose QCMDEXC after the first */
    expect(values(`SELECT 1 /* /* */ QCMDEXC( */ AS A`)).toEqual([
      `SELECT`,
      `1`,
      `AS`,
      `A`,
    ]);
  });

  test("`/*/` only opens a comment", () => {
    expect(values(`SELECT 1 AS A /*/ , QCMDEXC('X') AS R */ FROM T`)).toEqual([
      `SELECT`,
      `1`,
      `AS`,
      `A`,
      `FROM`,
      `T`,
    ]);
  });

  test("token values after a block comment are read from the right place", () => {
    // Matched tokens (statementType, keyword) take their value from the text
    expect(values(`(/*x*/INSERT`)).toEqual([`(`, `INSERT`]);
    expect(values(`NEXT VALUE/*x*/FOR S`)).toEqual([
      `NEXT`,
      `VALUE`,
      `FOR`,
      `S`,
    ]);
  });

  test("`--` comments end at LF and NEL, not at CR", () => {
    expect(values(`SELECT 1 -- c\u0085, QCMDEXC('X')`)).toEqual([
      `SELECT`,
      `1`,
      `,`,
      `QCMDEXC`,
      `(`,
      `'X'`,
      `)`,
    ]);
    expect(values(`SELECT 1 -- c\r, QCMDEXC('X')`)).toEqual([`SELECT`, `1`]);
  });

  test("FF, NEL and U+3000 separate words", () => {
    expect(values(`SELECT\fA\u0085FROM\u3000T`)).toEqual([
      `SELECT`,
      `A`,
      `FROM`,
      `T`,
    ]);
  });

  test("a quote ends the pending word", () => {
    expect(values(`SELECT DISTINCT"QCMDEXC"('X')`)).toEqual([
      `SELECT`,
      `DISTINCT`,
      `"QCMDEXC"`,
      `(`,
      `'X'`,
      `)`,
    ]);
    expect(values(`UPDATE"LIB"."T"`)).toEqual([`UPDATE`, `"LIB"`, `.`, `"T"`]);
    expect(values(`WHERE A LIKE'x'`)).toEqual([`WHERE`, `A`, `LIKE`, `'x'`]);
  });

  test("a literal prefix stays part of its string", () => {
    expect(values(`SELECT X'41', gx'00' FROM T`)).toEqual([
      `SELECT`,
      `X'41'`,
      `,`,
      `gx'00'`,
      `FROM`,
      `T`,
    ]);
  });

  test("token values after a quote are read from the right place", () => {
    // DROP becomes a matched token whose value is read back by range
    const tokens = new SQLTokeniser().tokenise(
      `ALTER TABLE MYLIB."T"DROP COLUMN C`,
    );
    expect(tokens.map((t) => t.value)).toContain(`DROP`);
    expect(values(`SELECT 'a'FROM T`)).toEqual([`SELECT`, `'a'`, `FROM`, `T`]);
  });

  test("a lone CR separates words and leaves no token in a statement", () => {
    const statement = new Document(`SELECT\rA\rFROM T`).statements[0]!;
    expect(statement.tokens.map((t) => t.value)).toEqual([
      `SELECT`,
      `A`,
      `FROM`,
      `T`,
    ]);
  });
});
