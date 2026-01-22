import { assert, expect, test } from "vitest";
import SQLTokeniser from "../../../src/ibmi-mcp-server/utils/language/tokens";

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
  expect(tokens[9].value.toLowerCase()).toBe(`for`);
});
