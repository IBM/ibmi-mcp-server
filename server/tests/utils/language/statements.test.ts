import { assert, describe, expect, test } from 'vitest'
import SQLTokeniser from '../../../src/ibmi-mcp-server/utils/language/tokens'
import Document, { getPositionData } from '../../../src/ibmi-mcp-server/utils/language/document';
import { CallableReference, ClauseType, StatementType } from '../../../src/ibmi-mcp-server/utils/language/types';

const parserScenarios = describe.each([
  {newDoc: (content: string) => new Document(content)},
]);

parserScenarios(`Basic statements`, ({newDoc}) => {
  test('One statement, no end', () => {
    const document = newDoc(`select * from sample`);

    expect(document.statements.length).toBe(1);
    expect(document.statements[0].tokens.length).toBe(4);
  });

  test('One statement, with end', () => {
    const document = newDoc(`select * from sample;`);

    expect(document.statements.length).toBe(1);
    expect(document.statements[0].type).toBe(StatementType.Select);
    expect(document.statements[0].tokens.length).toBe(4);
  });

  test('Two statements, one end', () => {
    const document = newDoc([
      `select * from sample;`,
      `select a from b.b`
    ].join(`\n`));

    expect(document.statements.length).toBe(2);
    expect(document.statements[0].tokens.length).toBe(4);
    expect(document.statements[1].tokens.length).toBe(6);

    expect(document.statements[0].getClauseForOffset(5)).toBe(ClauseType.Unknown);
    expect(document.statements[0].getClauseForOffset(10)).toBe(ClauseType.From);
  });

  test('Two statements, both end', () => {
    const document = newDoc([
      `select * from sample;`,
      `select a from b.b;`
    ].join(`\n`));

    expect(document.statements.length).toBe(2);
    expect(document.statements[0].tokens.length).toBe(4);
    expect(document.statements[1].tokens.length).toBe(6);
  });

  test('Two statements, both end, with comments', () => {
    const document = newDoc([
      `select * from sample; --Yep`,
      `select a from b.b; -- Nope`
    ].join(`\n`));

    expect(document.statements.length).toBe(2);
    expect(document.statements[0].tokens.length).toBe(4);
    expect(document.statements[1].tokens.length).toBe(6);
  });

  test('Two statements, both end, with comments, trimmed', () => {
    const document = newDoc([
      ``,
      `select * from sample; --Yep`,
      ``,
      ``,
      `select a from b.b; -- Nope`,
      ``,
      ``
    ].join(`\n`));

    expect(document.statements.length).toBe(2);
    expect(document.statements[0].tokens.length).toBe(4);
    expect(document.statements[1].tokens.length).toBe(6);
  });
});

parserScenarios(`Object references`, ({newDoc}) => {
  test('SELECT: Simple unqualified object', () => {
    const document = newDoc(`select * from sample;`);

    expect(document.statements.length).toBe(1);
    expect(document.statements[0].tokens.length).toBe(4);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(1);

    const obj = refs[0];
    expect(obj.tokens.length).toBe(1);
    expect(obj.object.name).toBe(`sample`);
    expect(obj.object.schema).toBeUndefined();
    expect(obj.alias).toBeUndefined();
  });

  test('SELECT: Simple qualified object', () => {
    const document = newDoc(`select * from myschema.sample;`);

    expect(document.statements.length).toBe(1);
    expect(document.statements[0].tokens.length).toBe(6);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(1);

    const obj = refs[0];
    expect(obj.tokens.length).toBe(3);
    expect(obj.object.name).toBe(`sample`);
    expect(obj.object.schema).toBe(`myschema`);
    expect(obj.alias).toBeUndefined();
  });

  test('SELECT: Simple qualified object with alias', () => {
    const document = newDoc(`select * from myschema.sample as a;`);

    expect(document.statements.length).toBe(1);
    expect(document.statements[0].tokens.length).toBe(8);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(1);

    const obj = refs[0];
    expect(obj.tokens.length).toBe(5);
    expect(obj.object.name).toBe(`sample`);
    expect(obj.object.schema).toBe(`myschema`);
    expect(obj.alias).toBe(`a`)
  });

  test('SELECT: one invalid, one valid', () => {
    const content = [
      `SELECT * FROM QSYS2.AUTHORITY_COLLECTION_LIBRARIES where;`,
      `SELECT * FROM QSYS2.AUTHORITY_COLLECTION;`,
    ].join(`\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(2);
    expect(document.statements[0].tokens.length).toBe(7);
    expect(document.statements[1].tokens.length).toBe(6);

    expect(document.statements[0].type).toBe(StatementType.Select);
    expect(document.statements[1].type).toBe(StatementType.Select);
  })

  test('SELECT: Simple unqualified object with alias (no AS)', () => {
    const document = newDoc(`select * from sample a;`);

    expect(document.statements.length).toBe(1);
    expect(document.statements[0].tokens.length).toBe(5);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(1);

    const obj = refs[0];
    expect(obj.tokens.length).toBe(2);
    expect(obj.object.name).toBe(`sample`);
    expect(obj.object.schema).toBeUndefined();
    expect(obj.alias).toBe(`a`)
  });

  test('SELECT: for in data-type (issue #315)', () => {
    const document = newDoc([
      `select cast(x'01' as char(1) for bit data) as something,`,
      `case when 1=1 then 'makes sense' else 'what?' end as something_else`,
      `from sysibm.sysdummy1;`
    ].join(`\n`));
  
    expect(document.statements.length).toBe(1);
    expect(document.statements[0].type).toBe(StatementType.Select);
  });

  test('SELECT: Simple qualified object with alias (no AS)', () => {
    const document = newDoc(`select * from myschema.sample a;`);

    expect(document.statements.length).toBe(1);
    expect(document.statements[0].tokens.length).toBe(7);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(1);

    const obj = refs[0];
    expect(obj.tokens.length).toBe(4);
    expect(obj.object.name).toBe(`sample`);
    expect(obj.object.schema).toBe(`myschema`);
    expect(obj.alias).toBe(`a`)
  });

  test('SELECT: Simple qualified object with alias (system naming)', () => {
    const document = newDoc(`select * from myschema/sample as a;`);

    expect(document.statements.length).toBe(1);
    expect(document.statements[0].tokens.length).toBe(8);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(1);

    const obj = refs[0];
    expect(obj.tokens.length).toBe(5);
    expect(obj.object.name).toBe(`sample`);
    expect(obj.object.schema).toBe(`myschema`);
    expect(obj.alias).toBe(`a`)
  });

  test(`SELECT: Two tables in FROM clause`, () => {
    const query = [
      `SELECT ORID, ORCUID, CUSTNM, ORYEAR,`,
      `   ORDATE,  ORDATDEL, ORDATCLO,`,
      `   COALESCE ( (SELECT SUM(ODTOTVAT)`,
      `              FROM   DETORD D`,
      `              WHERE H.ORID = ODORID ), 0) AS TOTVAL`,
      `FROM  "ORDER" H ,  CUSTOMER`,
      `WHERE ORCUID = CUID`,
    ].join(`\r\n`);

    const document = newDoc(query);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(5);

    expect(statement.getClauseForOffset(10)).toBe(ClauseType.Unknown);
    expect(statement.getClauseForOffset(125)).toBe(ClauseType.From);
    expect(statement.getClauseForOffset(160)).toBe(ClauseType.Where);
    expect(statement.getClauseForOffset(200)).toBe(ClauseType.From);
    expect(statement.getClauseForOffset(230)).toBe(ClauseType.Where);
  })

  test(`SELECT JOIN: inner join`, () => {
    const query = [
      `SELECT EMPNO, LASTNAME, PROJNO`,
      `FROM CORPDATA.EMPLOYEE INNER JOIN CORPDATA.PROJECT`,
      `      ON EMPNO = RESPEMP`,
      `WHERE LASTNAME > 'S';`,
    ].join(`\n`);

    const document = newDoc(query);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(2);

    const emp = refs[0];
    expect(emp.tokens.length).toBe(3);
    expect(emp.object.name).toBe(`EMPLOYEE`);
    expect(emp.object.schema).toBe(`CORPDATA`);
    expect(emp.alias).toBeUndefined();

    const proj = refs[1];
    expect(proj.tokens.length).toBe(3);
    expect(proj.object.name).toBe(`PROJECT`);
    expect(proj.object.schema).toBe(`CORPDATA`);
    expect(proj.alias).toBeUndefined();
  });

  test(`SELECT JOIN: left outer join`, () => {
    const query = [
      `SELECT EMPNO, LASTNAME, PROJNO`,
      `FROM CORPDATA.EMPLOYEE LEFT OUTER JOIN CORPDATA.PROJECT`,
      `      ON EMPNO = RESPEMP`,
      `WHERE LASTNAME > 'S'`,
    ].join(`\n`);

    const document = newDoc(query);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    expect(statement.tokens[10].type).toBe(`join`);
    expect(statement.tokens[10].value).toBe(`LEFT OUTER JOIN`);

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(2);

    const emp = refs[0];
    expect(emp.tokens.length).toBe(3);
    expect(emp.object.name).toBe(`EMPLOYEE`);
    expect(emp.object.schema).toBe(`CORPDATA`);
    expect(emp.alias).toBeUndefined();

    const proj = refs[1];
    expect(proj.tokens.length).toBe(3);
    expect(proj.object.name).toBe(`PROJECT`);
    expect(proj.object.schema).toBe(`CORPDATA`);
    expect(proj.alias).toBeUndefined();
  });

  test(`SELECT JOIN: right outer join`, () => {
    const query = [
      `SELECT EMPNO, LASTNAME, PROJNO`,
      `FROM CORPDATA.PROJECT RIGHT OUTER JOIN CORPDATA.EMPLOYEE`,
      `      ON EMPNO = RESPEMP`,
      `WHERE LASTNAME > 'S';`,
    ].join(`\n`);

    const document = newDoc(query);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(2);

    const proj = refs[0];
    expect(proj.tokens.length).toBe(3);
    expect(proj.object.name).toBe(`PROJECT`);
    expect(proj.object.schema).toBe(`CORPDATA`);
    expect(proj.alias).toBeUndefined();

    const emp = refs[1];
    expect(emp.tokens.length).toBe(3);
    expect(emp.object.name).toBe(`EMPLOYEE`);
    expect(emp.object.schema).toBe(`CORPDATA`);
    expect(emp.alias).toBeUndefined();
  });

  test(`SELECT JOIN: exception join`, () => {
    const query = [
      `SELECT EMPNO, LASTNAME, PROJNO`,
      `FROM CORPDATA.EMPLOYEE EXCEPTION JOIN PROJECT`,
      `      ON EMPNO = RESPEMP`,
      `WHERE LASTNAME > 'S'`,
    ].join(`\n`);

    const document = newDoc(query);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(2);

    const emp = refs[0];
    expect(emp.tokens.length).toBe(3);
    expect(emp.object.name).toBe(`EMPLOYEE`);
    expect(emp.object.schema).toBe(`CORPDATA`);
    expect(emp.alias).toBeUndefined();

    const proj = refs[1];
    expect(proj.tokens.length).toBe(1);
    expect(proj.object.name).toBe(`PROJECT`);
    expect(proj.object.schema).toBeUndefined();
    expect(proj.alias).toBeUndefined();
  });

  test(`SELECT JOIN: cross join`, () => {
    const query = [
      `SELECT * FROM A CROSS JOIN B`,
    ].join(`\n`);

    const document = newDoc(query);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(2);

    const A = refs[0];
    expect(A.tokens.length).toBe(1);
    expect(A.object.name).toBe(`A`);
    expect(A.object.schema).toBeUndefined;
    expect(A.alias).toBeUndefined();

    const B = refs[1];
    expect(B.tokens.length).toBe(1);
    expect(B.object.name).toBe(`B`);
    expect(B.object.schema).toBeUndefined();
    expect(B.alias).toBeUndefined();
  });

  test(`SELECT JOIN: full outer join`, () => {
    const query = [
      `SELECT EMPNO, LASTNAME, PROJNO`,
      `FROM EMPLOYEE as A FULL OUTER JOIN PROJECT b`,
      `      ON EMPNO = RESPEMP`,
      `WHERE LASTNAME > 'S'`,
    ].join(`\n`);

    const document = newDoc(query);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(2);

    const emp = refs[0];
    expect(emp.tokens.length).toBe(3);
    expect(emp.object.name).toBe(`EMPLOYEE`);
    expect(emp.object.schema).toBeUndefined;
    expect(emp.alias).toBe(`A`);

    const proj = refs[1];
    expect(proj.tokens.length).toBe(2);
    expect(proj.object.name).toBe(`PROJECT`);
    expect(proj.object.schema).toBeUndefined;
    expect(proj.alias).toBe(`b`);

    expect(statement.getClauseForOffset(10)).toBe(ClauseType.Unknown);
    expect(statement.getClauseForOffset(90)).toBe(ClauseType.From);
    expect(statement.getClauseForOffset(160)).toBe(ClauseType.Where);
  });

  test(`INSERT: simple inserts`, () => {
    const content = [
      `insert into talks (user, content) values ('LINUX', 'Hello world, my talk birdtalk'), ('LINUX', 'This is another thing I did #hi');`,
      `insert into "myschema".hashtags (tag, base_talk) values('#hi', 2);`,
    ].join(`\r\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(2);

    const talksStatement = document.statements[0];
    const hashtagsStatement = document.statements[1];

    const refsA = talksStatement.getObjectReferences();
    expect(refsA.length).toBe(1);
    expect(refsA[0].tokens.length).toBe(1);
    expect(refsA[0].object.name).toBe(`talks`);
    expect(refsA[0].object.schema).toBeUndefined();

    const refsB = hashtagsStatement.getObjectReferences();
    expect(refsB.length).toBe(1);
    expect(refsB[0].tokens.length).toBe(3);
    expect(refsB[0].object.name).toBe(`hashtags`);
    expect(refsB[0].object.schema).toBe(`"myschema"`);
  });

  test(`DELETE: simple delete`, () => {
    const content = [
      `delete from talks where id > 2;`
    ].join(`\r\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(1);

    const talksStatement = document.statements[0];

    const refsA = talksStatement.getObjectReferences();
    expect(refsA.length).toBe(1);
    expect(refsA[0].tokens.length).toBe(1);
    expect(refsA[0].object.name).toBe(`talks`);
    expect(refsA[0].object.schema).toBeUndefined();
  });

  test(`CALL: simple unqualified`, () => {
    const content = [
      `call create_Sql_sample('MYNEWSCHEMA');`
    ].join(`\r\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(1);

    const talksStatement = document.statements[0];

    const refsA = talksStatement.getObjectReferences();
    expect(refsA.length).toBe(1);

    expect(refsA[0].object.name).toBe(`create_Sql_sample`);
    expect(refsA[0].object.schema).toBeUndefined();

    const tokens = refsA[0].tokens;
    expect(tokens.length).toBe(4); // Includes the parameter tokens since it's a call
    expect(tokens[tokens.length-1].type).toBe(`closebracket`);
  });

  test(`CALL: simple qualified`, () => {
    const content = [
      `call "QSYS".create_Sql_sample('MYNEWSCHEMA');`
    ].join(`\r\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(1);

    const talksStatement = document.statements[0];

    const refsA = talksStatement.getObjectReferences();
    expect(refsA.length).toBe(1);

    expect(refsA[0].object.name).toBe(`create_Sql_sample`);
    expect(refsA[0].object.schema).toBe(`"QSYS"`);

    const tokens = refsA[0].tokens;
    expect(tokens.length).toBe(6); // Includes the parameter tokens since it's a call
    expect(tokens[tokens.length-1].type).toBe(`closebracket`);
  });

  test(`ALTER: with reference`, () => {
    const content = [
      `ALTER TABLE DEPARTMENT`,
      `      ADD FOREIGN KEY RDE (MGRNO)`,
      `          REFERENCES EMPLOYEE`,
      `          ON DELETE SET NULL;`,
    ].join(`\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    expect(statement.type).toBe(StatementType.Alter);

    const objs = statement.getObjectReferences();

    expect(objs.length).toBe(2);

    expect(objs[0].tokens.length).toBe(1);
    expect(objs[0].object.name).toBe(`DEPARTMENT`);
    expect(objs[0].object.schema).toBeUndefined();

    expect(objs[1].tokens.length).toBe(1);
    expect(objs[1].object.name).toBe(`EMPLOYEE`);
    expect(objs[1].object.schema).toBeUndefined();
  });

  test(`ALTER: with qualified reference`, () => {
    const content = [
      `ALTER TABLE myschema.dept`,
      `      ADD FOREIGN KEY RDE (MGRNO)`,
      `          REFERENCES myschema.emp`,
      `          ON DELETE SET NULL;`,
    ].join(`\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    expect(statement.type).toBe(StatementType.Alter);

    const objs = statement.getObjectReferences();

    expect(objs.length).toBe(2);

    expect(objs[0].tokens.length).toBe(3);
    expect(objs[0].object.name).toBe(`dept`);
    expect(objs[0].object.schema).toBe(`myschema`);

    expect(objs[1].tokens.length).toBe(3);
    expect(objs[1].object.name).toBe(`emp`);
    expect(objs[1].object.schema).toBe(`myschema`);
  });

  test(`CREATE INDEX: with and without UNIQUE`, () => {
    const content = [
      `CREATE UNIQUE INDEX XDEPT1`,
      `       ON DEPARTMENT (DEPTNO);`,
      ``,
      `CREATE INDEX XDEPT2`,
      `       ON DEPARTMENT (MGRNO);`,
    ].join(`\r\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(2);

    const withUnique = document.statements[0];
    const withoutUnique = document.statements[1];

    expect(withUnique.type).toBe(StatementType.Create);
    expect(withoutUnique.type).toBe(StatementType.Create);

    const refsA = withUnique.getObjectReferences();
    const refsB = withoutUnique.getObjectReferences();

    expect(refsA.length).toBe(2);
    expect(refsA[0].tokens.length).toBe(1);
    expect(refsA[0].createType).toBe(`INDEX`);
    expect(refsA[0].object.name).toBe(`XDEPT1`);
    expect(refsA[0].object.schema).toBeUndefined();
    expect(refsA[0].object.system).toBeUndefined();

    expect(refsA[1].tokens.length).toBe(1);
    expect(refsA[1].createType).toBeUndefined();
    expect(refsA[1].object.name).toBe(`DEPARTMENT`);
    expect(refsA[1].object.schema).toBeUndefined();
    expect(refsA[1].object.system).toBeUndefined();

    expect(refsB.length).toBe(2);
    expect(refsB[0].tokens.length).toBe(1);
    expect(refsB[0].createType).toBe(`INDEX`);
    expect(refsB[0].object.name).toBe(`XDEPT2`);
    expect(refsB[0].object.schema).toBeUndefined();
    expect(refsB[0].object.system).toBeUndefined();

    expect(refsB[1].tokens.length).toBe(1);
    expect(refsB[1].createType).toBeUndefined();
    expect(refsB[1].object.name).toBe(`DEPARTMENT`);
    expect(refsB[1].object.schema).toBeUndefined();
    expect(refsB[1].object.system).toBeUndefined();
  });

  test(`CREATE INDEX: with and without UNIQUE, but qualified`, () => {
    const content = [
      `CREATE UNIQUE INDEX myschema.XDEPT1`,
      `       ON other.DEPARTMENT (DEPTNO);`,
      ``,
      `CREATE INDEX myschema.XDEPT2`,
      `       ON other.DEPARTMENT (MGRNO);`,
    ].join(`\r\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(2);

    const withUnique = document.statements[0];
    const withoutUnique = document.statements[1];

    expect(withUnique.type).toBe(StatementType.Create);
    expect(withoutUnique.type).toBe(StatementType.Create);

    const refsA = withUnique.getObjectReferences();
    const refsB = withoutUnique.getObjectReferences();

    expect(refsA.length).toBe(2);
    expect(refsA[0].tokens.length).toBe(3);
    expect(refsA[0].createType).toBe(`INDEX`);
    expect(refsA[0].object.name).toBe(`XDEPT1`);
    expect(refsA[0].object.schema).toBe(`myschema`);
    expect(refsA[0].object.system).toBeUndefined();

    expect(refsA[1].tokens.length).toBe(3);
    expect(refsA[1].createType).toBeUndefined();
    expect(refsA[1].object.name).toBe(`DEPARTMENT`);
    expect(refsA[1].object.schema).toBe(`other`);

    expect(refsB.length).toBe(2);
    expect(refsB[0].tokens.length).toBe(3);
    expect(refsB[0].createType).toBe(`INDEX`);
    expect(refsB[0].object.name).toBe(`XDEPT2`);
    expect(refsB[0].object.schema).toBe(`myschema`);

    expect(refsB[1].tokens.length).toBe(3);
    expect(refsB[1].createType).toBeUndefined();
    expect(refsB[1].object.name).toBe(`DEPARTMENT`);
    expect(refsB[1].object.schema).toBe(`other`);
  });

  test(`CREATE TABLE: for system name`, () => {
    const content = [
      `--  Employee Master`,
      `--  Generated on:               11/03/21 14:32:20`,
      `CREATE OR REPLACE TABLE super_long_dept_name FOR SYSTEM NAME DEPT (`,
      `--  SQL150B   10   REUSEDLT(*NO) in table EMPMST in PAYROLL1 ignored.`,
      `  COL_B CHAR(1) CCSID 37 NOT NULL DEFAULT '' ,`,
      `  PRIMARY KEY( COL_B ) );`,
    ].join(`\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    expect(statement.type).toBe(StatementType.Create);

    const [mainRef] = statement.getObjectReferences();
    expect(mainRef.object.name).toBe(`super_long_dept_name`);
    expect(mainRef.object.system).toBe(`DEPT`);
  })

  test(`CREATE ALIAS`, () => {
    const content = [
      `create or replace view tagtalk for system name tt as (`,
      `  select b.*, a.tag`,
      `    from hashtags as a`,
      `    left join talks as b`,
      `      on a.base_talk = b.t_id`,
      `);`,
    ].join(`\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(1);

    const view = document.statements[0];

    expect(view.type).toBe(StatementType.Create);

    const defs = view.getObjectReferences();

    expect(defs.length).toBe(3);

    expect(defs[0].createType).toBe(`view`);
    expect(defs[0].object.name).toBe(`tagtalk`);
    expect(defs[0].object.schema).toBeUndefined();
    expect(defs[0].object.system).toBe(`tt`);
    expect(defs[0].alias).toBeUndefined();

    expect(defs[1].createType).toBeUndefined();
    expect(defs[1].object.name).toBe(`hashtags`);
    expect(defs[1].object.schema).toBeUndefined();
    expect(defs[1].alias).toBe(`a`);

    expect(defs[2].createType).toBeUndefined();
    expect(defs[2].object.name).toBe(`talks`);
    expect(defs[2].object.schema).toBeUndefined();
    expect(defs[2].alias).toBe(`b`);
  });

  test(`CREATE VIEW: with references`, () => {
    const content = [
      `CREATE VIEW ARTLSTDAT (`,
      `  ARID ,`,
      `  ARDESC ,`,
      `  LASTORDER ,`,
      `  QUANTITY )`,
      `  AS`,
      `  SELECT ARID, ARDESC,     MAX(ORDATE) AS LASTORDER , SUM(ODQTY) AS QUANTITY`,
      `    FROM  ARTICLE,            "ORDER",            DETORD`,
      `    WHERE ARID = ODARID AND ODORID = ORID GROUP BY ARID, ARDESC`,
      `  ;`,
    ].join(`\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(1);

    const view = document.statements[0];

    expect(view.type).toBe(StatementType.Create);

    const defs = view.getObjectReferences();

    expect(defs.length).toBe(4);
    expect(defs[0].createType).toBe(`VIEW`);
    expect(defs[0].object.name).toBe(`ARTLSTDAT`);
    expect(defs[0].object.schema).toBeUndefined();
    expect(defs[0].alias).toBeUndefined();

    expect(defs[1].createType).toBeUndefined();
    expect(defs[1].object.name).toBe(`ARTICLE`);
    expect(defs[1].object.schema).toBeUndefined();
    expect(defs[1].alias).toBeUndefined();

    expect(defs[2].createType).toBeUndefined();
    expect(defs[2].object.name).toBe(`"ORDER"`);
    expect(defs[2].object.schema).toBeUndefined();
    expect(defs[2].alias).toBeUndefined();

    expect(defs[3].createType).toBeUndefined();
    expect(defs[3].object.name).toBe(`DETORD`);
    expect(defs[3].object.schema).toBeUndefined();
    expect(defs[3].alias).toBeUndefined();
  });

  test(`CREATE VIEW: with references and alias`, () => {
    const content = [
      `CREATE VIEW ARTLSTDAT FOR SYSTEM NAME SHORT (`,
      `  ARID ,`,
      `  ARDESC ,`,
      `  LASTORDER ,`,
      `  QUANTITY )`,
      `  AS`,
      `  SELECT ARID, ARDESC,     MAX(ORDATE) AS LASTORDER , SUM(ODQTY) AS QUANTITY`,
      `    FROM  ARTICLE,            "ORDER",            DETORD`,
      `    WHERE ARID = ODARID AND ODORID = ORID GROUP BY ARID, ARDESC`,
      `  ;`,
    ].join(`\n`);

    const document = newDoc(content);

    expect(document.statements.length).toBe(1);

    const view = document.statements[0];

    expect(view.type).toBe(StatementType.Create);

    const defs = view.getObjectReferences();

    expect(defs.length).toBe(4);
    expect(defs[0].createType).toBe(`VIEW`);
    expect(defs[0].object.name).toBe(`ARTLSTDAT`);
    expect(defs[0].object.schema).toBeUndefined();
    expect(defs[0].object.system).toBe(`SHORT`);
    expect(defs[0].alias).toBeUndefined();

    expect(defs[1].createType).toBeUndefined();
    expect(defs[1].object.name).toBe(`ARTICLE`);
    expect(defs[1].object.schema).toBeUndefined();
    expect(defs[1].object.system).toBeUndefined();
    expect(defs[1].alias).toBeUndefined();

    expect(defs[2].createType).toBeUndefined();
    expect(defs[2].object.name).toBe(`"ORDER"`);
    expect(defs[2].object.schema).toBeUndefined();
    expect(defs[2].object.system).toBeUndefined();
    expect(defs[2].alias).toBeUndefined();

    expect(defs[3].createType).toBeUndefined();
    expect(defs[3].object.name).toBe(`DETORD`);
    expect(defs[3].object.schema).toBeUndefined();
    expect(defs[3].object.system).toBeUndefined();
    expect(defs[3].alias).toBeUndefined();
  });

  test(`CREATE FUNCTION: with specific, variables and references`, () => {
    const lines = [
      `create or replace function getTotalSalary () `,
      `  returns decimal(9, 2)`,
      `  specific GETTOTSAL`,
      `begin`,
      `  declare total decimal(9, 2);`,
      ``,
      `  select sum(salary) into total from employee;`,
      ``,
      `  return total;`,
      `end;`,
    ].join(`\n`);

    const document = newDoc(lines);
    const groups = document.getStatementGroups();

    expect(groups.length).toBe(1);

    const [group] = groups;

    const createStatement = group.statements[0];

    const parms = createStatement.getRoutineParameters();
    expect(parms.length).toBe(0);

    const refsA = createStatement.getObjectReferences();
    expect(createStatement.type).toBe(StatementType.Create);
    expect(refsA.length).toBe(1);
    expect(refsA[0].createType).toBe(`function`);
    expect(refsA[0].object.name).toBe(`getTotalSalary`);
    expect(refsA[0].object.schema).toBeUndefined();
    expect(refsA[0].object.system).toBe(`GETTOTSAL`);

    // Let's check we get the variable back for this declare
    const declareStatement = group.statements[1];
    expect(declareStatement.type).toBe(StatementType.Declare);
    const refsB = declareStatement.getObjectReferences();
    expect(refsB.length).toBe(1);
    expect(refsB[0].createType).toBe(`decimal(9, 2)`);
    expect(refsB[0].object.name).toBe(`total`);

    // Let's check we get the table back for this select
    const selectStatement = group.statements[2];
    expect(selectStatement.type).toBe(StatementType.Select);
    const refsC = selectStatement.getObjectReferences();
    expect(refsC.length).toBe(2);
    expect(refsC[0].createType).toBeUndefined();
    expect(refsC[0].object.name).toBe(`sum`);
    expect(refsC[1].createType).toBeUndefined();
    expect(refsC[1].object.name).toBe(`employee`);
  });
  
  test(`CREATE FUNCTION: with multiple parameters`, () => {
    const lines = [
      `create or replace function watsonx.generate(`,
      `  text varchar(1000) ccsid 1208,`,
      `  model_id varchar(128) ccsid 1208 default 'meta-llama/llama-2-13b-chat',`,
      `  parameters varchar(1000) ccsid 1208 default null`,
      `)`,
      `  returns varchar(10000) ccsid 1208`,
      `  not deterministic`,
      `  no external action`,
      `  set option usrprf = *user, dynusrprf = *user, commit = *none`,
      `begin`,
      `  declare watsonx_response Varchar(10000) CCSID 1208;`,
      `  declare needsNewToken char(1) default 'Y';`,
      ``,
      `  set needsNewToken = watsonx.ShouldGetNewToken();`,
      `  if (needsNewToken = 'Y') then`,
      `    return '*PLSAUTH';`,
      `  end if;`,
      ``,
      `  return '';`,
      `end;`,
    ].join(`\n`);

    const document = newDoc(lines);
    const groups = document.getStatementGroups();

    expect(groups.length).toBe(1);
    const group = groups[0];

    const createStatement = group.statements[0];

    const parms = createStatement.getRoutineParameters();
    expect(parms.length).toBe(3);

    expect(parms[0].alias).toBe(`text`);
    expect(parms[0].createType).toBe(`varchar(1000) ccsid 1208`);

    expect(parms[1].alias).toBe(`model_id`);
    expect(parms[1].createType).toBe(`varchar(128) ccsid 1208 default 'meta-llama/llama-2-13b-chat'`);

    expect(parms[2].alias).toBe(`parameters`);
    expect(parms[2].createType).toBe(`varchar(1000) ccsid 1208 default null`);
  });

  test(`CREATE PROCEDURE: with EXTERNAL NAME`, () => {
    const lines = [
      `create or replace procedure schema.coolness (IN base CHAR(100)) `,
      `LANGUAGE RPGLE`,
      `EXTERNAL NAME LIB.PROGRAM GENERAL;`,
    ].join(`\n`);

    const document = newDoc(lines);
    const groups = document.getStatementGroups();

    expect(groups.length).toBe(1);
    const createStatement = groups[0].statements[0];

    expect(createStatement.type).toBe(StatementType.Create);

    const parms = createStatement.getRoutineParameters();
    expect(parms.length).toBe(1);
    expect(parms[0].alias).toBe(`base`);
    expect(parms[0].createType).toBe(`IN CHAR(100)`);

    const refs = createStatement.getObjectReferences();
    expect(refs.length).toBe(2);

    expect(refs[0].createType).toBe(`procedure`);
    expect(refs[0].object.name).toBe(`coolness`);
    expect(refs[0].object.schema).toBe(`schema`);
    expect(refs[0].object.system).toBeUndefined();

    expect(refs[1].createType).toBe(`external`);
    expect(refs[1].object.system).toBe(`PROGRAM`);
    expect(refs[1].object.schema).toBe(`LIB`);
  });

  test('CREATE TABLE: routine parametes with primary key', () => {
    const content = [
      `--  Employee Master`,
      `--  Generated on:               11/03/21 14:32:20`,
      `CREATE OR REPLACE TABLE super_long_dept_name FOR SYSTEM NAME DEPT (`,
      `--  SQL150B   10   REUSEDLT(*NO) in table EMPMST in PAYROLL1 ignored.`,
      `  COL_B CHAR(1) CCSID 37 NOT NULL DEFAULT '' ,`,
      `  PRIMARY KEY( COL_B ) );`,
    ].join(`\n`);

    const document = newDoc(content);
    const groups = document.getStatementGroups();

    expect(groups.length).toBe(1);
    const createStatement = groups[0].statements[0];

    expect(createStatement.type).toBe(StatementType.Create);

    const parms = createStatement.getRoutineParameters();
    expect(parms.length).toBe(1);
    expect(parms[0].alias).toBe(`COL_B`);
  });

  test('CREATE TABLE: simple routine parametes test', () => {
    const content = [
      `CREATE TABLE ROSSITER.INVENTORY`,
      `(PARTNO         SMALLINT     NOT NULL,`,
      ` DESCR          VARCHAR(24),`,
      ` QONHAND        INT)`,
    ].join(`\n`);

    const document = newDoc(content);
    const groups = document.getStatementGroups();

    expect(groups.length).toBe(1);
    const createStatement = groups[0].statements[0];

    expect(createStatement.type).toBe(StatementType.Create);

    const parms = createStatement.getRoutineParameters();
    expect(parms.length).toBe(3);

    expect(parms[0].alias).toBe(`PARTNO`);
    expect(parms[0].createType).toBe(`SMALLINT NOT NULL`);
    
    expect(parms[1].alias).toBe(`DESCR`);
    expect(parms[1].createType).toBe(`VARCHAR(24)`);

    expect(parms[2].alias).toBe(`QONHAND`);
    expect(parms[2].createType).toBe(`INT`);
  });

  test('CREATE TABLE: generated types', () => {
    const content = [
      `CREATE TABLE policy_info`,
      `  (policy_id CHAR(10) NOT NULL,`,
      `  coverage INT NOT NULL,`,
      `  sys_start TIMESTAMP(12) NOT NULL GENERATED ALWAYS AS ROW BEGIN,`,
      `  sys_end TIMESTAMP(12) NOT NULL GENERATED ALWAYS AS ROW END,`,
      `  create_id TIMESTAMP(12) GENERATED ALWAYS AS TRANSACTION START ID,`,
      `  PERIOD SYSTEM_TIME(sys_start,sys_end));`,
    ].join(`\n`);

    const document = newDoc(content);
    const groups = document.getStatementGroups();
    
    expect(groups.length).toBe(1);
    const createStatement = groups[0].statements[0];

    expect(createStatement.type).toBe(StatementType.Create);

    const parms = createStatement.getRoutineParameters();
    expect(parms.length).toBe(5);

    expect(parms[0].alias).toBe(`policy_id`);
    expect(parms[0].createType).toBe(`CHAR(10) NOT NULL`);

    expect(parms[1].alias).toBe(`coverage`);
    expect(parms[1].createType).toBe(`INT NOT NULL`);

    expect(parms[2].alias).toBe(`sys_start`);
    expect(parms[2].createType).toBe(`TIMESTAMP(12) NOT NULL GENERATED ALWAYS AS ROW BEGIN`);

    expect(parms[3].alias).toBe(`sys_end`);
    expect(parms[3].createType).toBe(`TIMESTAMP(12) NOT NULL GENERATED ALWAYS AS ROW END`);

    expect(parms[4].alias).toBe(`create_id`);
    expect(parms[4].createType).toBe(`TIMESTAMP(12) GENERATED ALWAYS AS TRANSACTION START ID`);
  })

  test(`DECLARE VARIABLE`, () => {
    const document = newDoc(`declare watsonx_response   Varchar(10000) CCSID 1208;`);
    const groups = document.getStatementGroups();

    expect(groups.length).toBe(1);
    const createStatement = groups[0].statements[0];

    expect(createStatement.type).toBe(StatementType.Declare);
    const refs = createStatement.getObjectReferences();
    expect(refs.length).toBe(1);

    expect(refs[0].object.name).toBe(`watsonx_response`);
    expect(refs[0].createType).toBe(`Varchar(10000) CCSID 1208`);
  });

  test(`CREATE OR REPLACE VARIABLE`, () => {
    const document = newDoc(`create or replace variable watsonx.apiVersion varchar(10) ccsid 1208 default '2023-07-07';`);

    const groups = document.getStatementGroups();

    expect(groups.length).toBe(1);
    const createStatement = groups[0].statements[0];

    expect(createStatement.type).toBe(StatementType.Create);
    const refs = createStatement.getObjectReferences();
    expect(refs.length).toBe(1);

    expect(refs[0].object.schema).toBe(`watsonx`);
    expect(refs[0].object.name).toBe(`apiVersion`);
    expect(refs[0].createType).toBe(`varchar(10) ccsid 1208 default '2023-07-07'`);
  });

  test(`SELECT, WITH & LATERAL`, () => {
    const lines = [
      `with qsysobjs (lib, obj, type) as (`,
      `  select object_library, object_name, object_type`,
      `    from table (qsys2.object_ownership(current_user))`,
      `    where path_name is null`,
      `)`,
      `select lib concat '/' concat obj concat ' (' concat type concat ')' as label,`,
      `       objsize as "Size"`,
      `  from qsysobjs q, lateral (`,
      `         select objcreated, last_used_timestamp, objsize`,
      `           from table (qsys2.object_statistics(lib, type, obj))`,
      `       ) z`,
      `where objsize is not null`,
      `order by OBJSIZE DESC`,
      `limit 10;`,
    ].join(`\n`);

    const document = new Document(lines);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    expect(statement.type).toBe(StatementType.With);

    const refs = statement.getObjectReferences();
    expect(refs.length).toBe(3);

    expect(refs[0].object.name).toBe(`object_ownership`);
    expect(refs[0].object.schema).toBe(`qsys2`);

    expect(refs[1].object.name).toBe(`qsysobjs`);
    expect(refs[1].object.schema).toBeUndefined();
    expect(refs[1].alias).toBe(`q`);
    
    expect(refs[2].object.name).toBe(`object_statistics`);
    expect(refs[2].object.schema).toBe(`qsys2`);
    expect(refs[2].alias).toBe(undefined);
  });

  test('SELECT FROM LATERAL', () => {
    const lines = [
      `SELECT id, id_phone, t.phone_number`,
      `  FROM testlateral AS s,`,
      `       LATERAL(VALUES (1, S.phone1),`,
      `                      (2, S.phone2),`,
      `                      (3, S.phone3)) AS T(id_phone, phone_number)`,
    ].join(`\n`);

    const document = new Document(lines);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    expect(statement.type).toBe(StatementType.Select);

    const refs = statement.getObjectReferences();
    console.log(refs);
    expect(refs.length).toBe(1);
  });

  test(`Multiple UDTFs`, () => {
    const lines = [
      `SELECT b.objlongschema, b.objname, b.objtype, b.objattribute, b.objcreated, b.objsize, b.objtext, b.days_used_count, b.last_used_timestamp,b.* FROM `,
      `   TABLE (QSYS2.OBJECT_STATISTICS('*ALLUSRAVL ', '*LIB') ) as a, `,
      `   TABLE (QSYS2.OBJECT_STATISTICS(a.objname, 'ALL')  ) AS b`,
      `WHERE b.OBJOWNER = 'user-name'`,
      `ORDER BY b.OBJSIZE DESC`,
      `FETCH FIRST 100 ROWS ONLY;`,
    ].join(`\n`);

    const document = new Document(lines);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    expect(statement.type).toBe(StatementType.Select);

    const refs = statement.getObjectReferences();

    expect(refs.length).toBe(2);
    expect(refs[0].object.name).toBe(`OBJECT_STATISTICS`);
    expect(refs[0].object.schema).toBe(`QSYS2`);
    expect(refs[0].alias).toBe(`a`);

    expect(refs[1].object.name).toBe(`OBJECT_STATISTICS`);
    expect(refs[1].object.schema).toBe(`QSYS2`);
    expect(refs[1].alias).toBe(`b`);
  });

  test('LOOP statements', () => {
    const lines = [
      `CREATE OR REPLACE PROCEDURE KRAKEN917.Wait_For_Kraken(kraken_job_name varchar(10), delay_time bigint default 30)`,
      `BEGIN`,
      `    DECLARE v_sql_stmt CLOB(1M) CCSID 37;`,
      ``,
      `    DECLARE number_of_active_jobs INT;`,
      ``,
      `    CALL systools.lprintf('Waiting for job to finish...');`,
      ``,
      `    fetch_loop: LOOP`,
      `        SET v_sql_stmt ='values(SELECT COUNT(*) FROM TABLE (qsys2.active_job_info(subsystem_list_filter => ''QBATCH'')) WHERE JOB_NAME_SHORT LIKE ''' CONCAT kraken_job_name CONCAT ''') into ?';`,
      ``,
      `        PREPARE values_st FROM v_sql_stmt;`,
      ``,
      `        EXECUTE values_st USING number_of_active_jobs;`,
      ``,
      `        IF number_of_active_jobs = 0 THEN`,
      `            CALL SYSTOOLS.LPRINTF(kraken_job_name CONCAT ' JOB DONE');`,
      ``,
      `            LEAVE fetch_loop;`,
      ``,
      `        END IF;`,
      ``,
      `        CALL qsys2.qcmdexc('DLYJOB ' CONCAT delay_time);`,
      ``,
      `    END LOOP fetch_loop;`,
      ``,
      `END;`,
    ].join(`\n`);

    const document = new Document(lines);

    const groups = document.getStatementGroups();
    expect(groups.length).toBe(1);

    const group = groups[0];

    // console.log(group.statements.map((s, so) => `${so}  ` + s.type.padEnd(10) + ` ` + s.tokens.map(t => t.value).join(' ')));

    expect(group.statements.length).toBe(16);
    expect(group.statements.map(s => s.type)).toEqual([
      'Create',  'Declare',
      'Declare', 'Call',
      'Loop', 'Set',
      'Unknown', 'Unknown',
      'If', 'Call',
      'Leave', 'End',
      'Call',    'End',
      'Unknown', 'End'
    ]);

    let refs;

    const firstCall = group.statements[3];
    refs = firstCall.getObjectReferences();
    expect(refs.length).toBe(1);
    expect(refs[0].object.name).toBe(`lprintf`);

    const secondCall = group.statements[9];
    refs = secondCall.getObjectReferences();
    expect(refs.length).toBe(1);
    expect(refs[0].object.name).toBe(`LPRINTF`);

    const thirdCall = group.statements[12];
    refs = thirdCall.getObjectReferences();
    expect(refs.length).toBe(1);
    expect(refs[0].object.name).toBe(`qcmdexc`);
  })
});

parserScenarios(`Offset reference tests`, ({newDoc}) => {
  test(`Writing select`, () => {
    const document = newDoc(`select * from sample.;`);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    const ref = statement.getReferenceByOffset(21);
    expect(ref).toBeDefined();
    expect(ref.object.schema).toBe(`sample`);
    expect(ref.object.name).toBeUndefined();
  });

  test(`Writing select, invalid middle`, () => {
    const document = newDoc(`select b. from department b;`);

    expect(document.statements.length).toBe(1);

    const statement = document.statements[0];

    const objs = statement.getObjectReferences();
    expect(objs.length).toBe(1);
    expect(objs[0].object.schema).toBeUndefined();
    expect(objs[0].object.name).toBe(`department`);
    expect(objs[0].alias).toBe(`b`);

    const ref = statement.getReferenceByOffset(9);
    expect(ref).toBeDefined();
    expect(ref.object.schema).toBe(`b`);
    expect(ref.object.name).toBeUndefined();
  });
});

parserScenarios(`PL body tests`, ({newDoc}) => {
  test(`CREATE PROCEDURE: with body`, () => {
    const lines = [
      `CREATE PROCEDURE MEDIAN_RESULT_SET (OUT medianSalary DECIMAL(7,2))`,
      `LANGUAGE SQL `,
      `DYNAMIC RESULT SETS 1`,
      `BEGIN `,
      `  DECLARE v_numRecords INTEGER DEFAULT 1;`,
      `  DECLARE v_counter INTEGER DEFAULT 0;`,
      `  DECLARE c1 CURSOR FOR `,
      `    SELECT salary `,
      `        FROM staff `,
      `        ORDER BY salary;`,
      `  DECLARE c2 CURSOR WITH RETURN FOR `,
      `    SELECT name, job, salary `,
      `        FROM staff `,
      `        WHERE salary > medianSalary`,
      `        ORDER BY salary;`,
      `  DECLARE EXIT HANDLER FOR NOT FOUND`,
      `    SET medianSalary = 6666; `,
      `  SET medianSalary = 0;`,
      `  SELECT COUNT(*) INTO v_numRecords FROM STAFF;`,
      `  OPEN c1;`,
      `  WHILE v_counter < (v_numRecords / 2 + 1) `,
      `    DO FETCH c1 INTO medianSalary;`,
      `    SET v_counter = v_counter + 1;`,
      `  END WHILE;`,
      `  CLOSE c1;`,
      `  OPEN c2;`,
      `END`,
    ].join(`\r\n`);

    const document = newDoc(lines);
    const statements = document.statements;

    const medianResultSetProc = statements[0];
    expect(medianResultSetProc.type).toBe(StatementType.Create);
    expect(medianResultSetProc.isCompoundStart()).toBe(true);

    const parms = medianResultSetProc.getRoutineParameters();
    expect(parms.length).toBe(1);
    expect(parms[0].alias).toBe(`medianSalary`);
    expect(parms[0].createType).toBe(`OUT DECIMAL(7, 2)`);

    const numRecordsDeclare = statements[1];
    expect(numRecordsDeclare.type).toBe(StatementType.Declare);

    const endStatement = statements[statements.length - 1];
    expect(endStatement.type).toBe(StatementType.End);

    const endStatements = statements.filter(stmt => stmt.type === StatementType.End);
    expect(endStatements.length).toBe(2);

    // END WHILE
    expect(endStatements[0].tokens.length).toBe(2);

    // END
    expect(endStatements[1].tokens.length).toBe(1);

    const whileStatement = statements.find(stmt => stmt.type === StatementType.While);
    expect(whileStatement).toBeDefined();

    const fetchStatement = statements.find(stmt => stmt.type === StatementType.Fetch);
    expect(fetchStatement).toBeDefined();
  });

  test(`CREATE PROCEDURE followed by CALL statement`, () => {
    const lines = [
      `CREATE PROCEDURE MEDIAN_RESULT_SET (OUT medianSalary DECIMAL(7,2))`,
      `LANGUAGE SQL `,
      `DYNAMIC RESULT SETS 1`,
      `BEGIN `,
      `  DECLARE v_numRecords INTEGER DEFAULT 1;`,
      `  DECLARE v_counter INTEGER DEFAULT 0;`,
      `  DECLARE c1 CURSOR FOR `,
      `    SELECT salary `,
      `        FROM staff `,
      `        ORDER BY salary;`,
      `  DECLARE c2 CURSOR WITH RETURN FOR `,
      `    SELECT name, job, salary `,
      `        FROM staff `,
      `        WHERE salary > medianSalary`,
      `        ORDER BY salary;`,
      `  DECLARE EXIT HANDLER FOR NOT FOUND`,
      `    SET medianSalary = 6666; `,
      `  SET medianSalary = 0;`,
      `  SELECT COUNT(*) INTO v_numRecords FROM STAFF;`,
      `  OPEN c1;`,
      `  WHILE v_counter < (v_numRecords / 2 + 1) `,
      `    DO FETCH c1 INTO medianSalary;`,
      `    SET v_counter = v_counter + 1;`,
      `  END WHILE;`,
      `  CLOSE c1;`,
      `  OPEN c2;`,
      `END;`,
      ``,
      `CALL MEDIAN_RESULT_SET(12345.55);`,
    ].join(`\r\n`);

    const document = newDoc(lines);
    const statements = document.statements;

    const medianResultSetProc = statements[0];
    expect(medianResultSetProc.type).toBe(StatementType.Create);
    expect(medianResultSetProc.isCompoundStart()).toBe(true);

    const parms = medianResultSetProc.getRoutineParameters();
    expect(parms.length).toBe(1);
    expect(parms[0].alias).toBe(`medianSalary`);
    expect(parms[0].createType).toBe(`OUT DECIMAL(7, 2)`);

    const parameterTokens = medianResultSetProc.getBlockAt(46);
    expect(parameterTokens.length).toBeGreaterThan(0);
    expect(parameterTokens.map(t => t.type).join()).toBe([`parmType`, `word`, `word`, `openbracket`, `number`, `comma`, `number`, `closebracket`].join());

    const numRecordsDeclare = statements[1];
    expect(numRecordsDeclare.type).toBe(StatementType.Declare);

    const endStatement = statements[statements.length - 2];
    expect(endStatement.type).toBe(StatementType.End);

    const callStatement = statements[statements.length - 1];
    expect(callStatement.type).toBe(StatementType.Call);
    expect(callStatement.isCompoundStart()).toBe(false);

    const blockParent = callStatement.getCallableDetail(callStatement.tokens[3].range.start);
    expect(blockParent).toBeDefined();
    expect(blockParent.tokens.length).toBe(3);
    expect(blockParent.parentRef.object.name).toBe(`MEDIAN_RESULT_SET`);
  });

  test(`WITH: no explicit columns`, () => {
    const lines = [
      `with Temp01 as`,
      `(select s.shipmentID, s.customerID, s.amount`,
      `   from shipments as s`,
      `  where s.shipdate =`,
      `      (select BillingDate from BillingDate)),`,
      `Temp02 as`,
      `  (select sum(t1.amount) as TotalShipped`,
      `    from Temp01 as t1),`,
      `Temp03 as`,
      `  (select t1.shipmentID, t1.customerID, c.name, t1.amount, `,
      `          dec(round(t1.amount / t2.TotalShipped * 100,2),5,2`,
      `          ) as Percentage`,
      `    from Temp01 as t1`,
      `    cross join Temp02 as t2`,
      `    join customers as c`,
      `      on t1.customerID = c.account)`,
      `/* select t3.* from Temp03 as t3`,
      `order by t3.shipmentID; */`,
      `select * from Temp02`,
    ].join(`\n`);

    const document = newDoc(lines);
    const statements = document.statements;

    expect(statements.length).toBe(1);

    const statement = statements[0];
    expect(statement.type).toBe(StatementType.With);

    const refs = statement.getObjectReferences();
    const ctes = statement.getCTEReferences();
    
    expect(refs.length).toBe(10);
    expect(refs[0].object.name).toBe(`shipments`);
    expect(refs[0].alias).toBe(`s`);

    expect(refs[1].object.name).toBe(`BillingDate`);
    expect(refs[1].alias).toBeUndefined();

    expect(refs[2].object.name).toBe(`sum`);
    expect(refs[2].alias).toBeUndefined();

    expect(refs[3].object.name).toBe(`Temp01`);
    expect(refs[3].alias).toBe(`t1`);

    expect(refs[4].object.name).toBe(`dec`);
    expect(refs[4].alias).toBeUndefined();

    expect(refs[5].object.name).toBe(`round`);
    expect(refs[5].alias).toBeUndefined();

    expect(refs[6].object.name).toBe(`Temp01`);
    expect(refs[6].alias).toBe(`t1`);

    expect(refs[7].object.name).toBe(`Temp02`);
    expect(refs[7].alias).toBe(`t2`);

    expect(refs[8].object.name).toBe(`customers`);
    expect(refs[8].alias).toBe(`c`);

    expect(refs[9].object.name).toBe(`Temp02`);
    expect(refs[9].alias).toBeUndefined();

    expect(ctes.length).toBe(3);
    expect(ctes[0].name).toBe(`Temp01`);
    expect(ctes[0].columns.length).toBe(0);

    expect(ctes[1].name).toBe(`Temp02`);
    expect(ctes[1].columns.length).toBe(0);

    expect(ctes[2].name).toBe(`Temp03`);
    expect(ctes[2].columns.length).toBe(0);

    const temp03Stmt = ctes[2].statement.getObjectReferences();

    expect(temp03Stmt[0].object.name).toBe(`dec`);
    expect(temp03Stmt[1].object.name).toBe(`Temp01`);
    expect(temp03Stmt[2].object.name).toBe(`Temp02`);
    expect(temp03Stmt[3].object.name).toBe(`customers`);
  })

  test(`WITH: explicit columns`, () => {
    const lines = [
      `with cteme(n1,n2,n3) as (`,
      `  select * from qsys2.sysixadv`,
      `  --     |`,
      `)`,
      `select * from cteme`
    ].join(`\r\n`);

    const document = newDoc(lines);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];
    expect(statement.type).toBe(StatementType.With);

    const objs = statement.getObjectReferences();
    expect(objs.length).toBe(2);
    expect(objs[0].object.schema).toBe(`qsys2`);
    expect(objs[0].object.name).toBe(`sysixadv`);
    expect(objs[1].object.schema).toBe(undefined);
    expect(objs[1].object.name).toBe(`cteme`);

    const ctes = statement.getCTEReferences();
    expect(ctes.length).toBe(1);
    expect(ctes[0].name).toBe(`cteme`);
    expect(ctes[0].columns.join()).toBe([`n1`, `n2`, `n3`].join());

    const cteSubselect = ctes[0].statement;
    const cteObjs = cteSubselect.getObjectReferences();
    expect(cteObjs.length).toBe(1);
    expect(cteObjs[0].object.schema).toBe(`qsys2`);
    expect(cteObjs[0].object.name).toBe(`sysixadv`);
  });

  test(`SELECT: table function`, () => {
    const lines = `select * from table(qsys2.mti_info());`;

    const document = newDoc(lines);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];
    expect(statement.type).toBe(StatementType.Select);

    const objs = statement.getObjectReferences();
    expect(objs.length).toBe(1);
    expect(objs[0].object.schema).toBe(`qsys2`);
    expect(objs[0].object.name).toBe(`mti_info`);
    expect(objs[0].isUDTF).toBe(true);
    expect(objs[0].alias).toBeUndefined();
  });

  test(`SELECT: table function with name (no AS)`, () => {
    const lines = `select * from table(qsys2.mti_info()) x;`;

    const document = newDoc(lines);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];
    expect(statement.type).toBe(StatementType.Select);

    const objs = statement.getObjectReferences();
    expect(objs.length).toBe(1);
    expect(objs[0].object.schema).toBe(`qsys2`);
    expect(objs[0].object.name).toBe(`mti_info`);
    expect(objs[0].alias).toBe(`x`);
    expect(objs[0].isUDTF).toBe(true);
  });

  test(`SELECT: table function with name (with AS)`, () => {
    const lines = `select * from table(qsys2.mti_info()) as x;`;

    const document = newDoc(lines);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];
    expect(statement.type).toBe(StatementType.Select);

    const objs = statement.getObjectReferences();
    expect(objs.length).toBe(1);
    expect(objs[0].object.schema).toBe(`qsys2`);
    expect(objs[0].object.name).toBe(`mti_info`);
    expect(objs[0].alias).toBe(`x`);
    expect(objs[0].isUDTF).toBe(true);
  });

  test(`SELECT & STOP`, () => {
    const lines = [
      `--`,
      `-- What did Tim do?`,
      `--`,
      `select count(*) as tims_batch_job_count`,
      `  from table (`,
      `      qsys2. ACTIVE_JOB_INFO(JOB_NAME_FILTER       => 'TIMDIDIT', `,
      `                      SUBSYSTEM_LIST_FILTER => 'QBATCH')`,
      `    );`,
      `stop;`,
    ].join(`\n`);

    const document = newDoc(lines);
    const statements = document.statements;
    expect(statements.length).toBe(2);

    const statement = statements[0];
    expect(statement.type).toBe(StatementType.Select);

    const objs = statement.getObjectReferences();

    expect(objs.length).toBe(2);
    expect(objs[1].object.schema).toBe(`qsys2`);
    expect(objs[1].object.name).toBe(`ACTIVE_JOB_INFO`);
  });

  test('CASE, WHEN, END', () => {
    const lines = [
      `--`,
      ``,
      `--`,
      `-- Hold any jobs that started running an SQL statement more than 2 hours ago.`,
      `--`,
      `select JOB_NAME,`,
      `       case`,
      `         when QSYS2.QCMDEXC('HLDJOB ' concat JOB_NAME) = 1 then 'Job Held'`,
      `         else 'Job not held'`,
      `       end as HLDJOB_RESULT`,
      `  from table (`,
      `      QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'ALL')`,
      `    )`,
      `  where SQL_STATEMENT_START_TIMESTAMP < current timestamp - 2 hours;`,
    ].join(`\n`);

    const document = newDoc(lines);


    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];
    expect(statement.type).toBe(StatementType.Select);

    const objs = statement.getObjectReferences();

    expect(objs.length).toBe(2);
  });



  test('SELECT statement with CASE', () => {
    const content = [
      `SELECT`,
      `    CLE,`,
      `    CASE`,
      `        WHEN CLE = 1 THEN 'FIRST' Else VALEUR End As VALEUR`,
      `FROM`,
      `    QTEMP.Test`,
    ].join(` `);

    const document = new Document(content);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];
    expect(statement.type).toBe(StatementType.Select);

    
  });
});

describe(`Parameter statement tests`, () => {
  test(`Single questionmark parameter test`, () => {
    const document = new Document(`select * from sample where x = ?`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const markerRanges = statement.getEmbeddedStatementAreas();
    expect(markerRanges.length).toBe(1);
  });

  test(`Single host parameter test`, () => {
    const document = new Document(`select * from sample where x = :value`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const markerRanges = statement.getEmbeddedStatementAreas();
    expect(markerRanges.length).toBe(1);
  });

  test(`Single host qualified parameter test`, () => {
    const document = new Document(`select * from sample where x = :struct.value`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const markerRanges = statement.getEmbeddedStatementAreas();
    expect(markerRanges.length).toBe(1);
  });

  test(`Single INTO clause test`, () => {
    const document = new Document(`select abcd into :myvar from sample where x = 1`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const markerRanges = statement.getEmbeddedStatementAreas();
    expect(markerRanges.length).toBe(1);
  });

  test(`Single INTO clause and host qualified parameter test`, () => {
    const document = new Document(`select * into :myds from sample where x = :struct.value`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const markerRanges = statement.getEmbeddedStatementAreas();
    expect(markerRanges.length).toBe(2);
  });

  test(`Double questionmark parameter test`, () => {
    const document = new Document(`select * from sample where x = ? and y=?`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const markerRanges = statement.getEmbeddedStatementAreas();
    expect(markerRanges.length).toBe(2);
  });

  test(`Double host parameter test`, () => {
    const document = new Document(`select * from sample where x = :value and y=:whoop`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const markerRanges = statement.getEmbeddedStatementAreas();
    expect(markerRanges.length).toBe(2);
  });

  test(`Double host qualified parameter test`, () => {
    const document = new Document(`select * from sample where x = :struct.value or y=:struct.val`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const markerRanges = statement.getEmbeddedStatementAreas();
    expect(markerRanges.length).toBe(2);
  });

  test('JSON_OBJECT parameters should not mark as embedded', () => {
    const document = new Document(`values json_object('model_id': 'meta-llama/llama-2-13b-chat', 'input': 'TEXT', 'parameters': json_object('max_new_tokens': 100, 'time_limit': 1000), 'space_id': 'SPACEID')`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const markerRanges = statement.getEmbeddedStatementAreas();
    expect(markerRanges.length).toBe(0);
  });

  test(`Single questionmark parameter content test`, () => {
    const sql = `select * from sample where x = ?`;
    const document = new Document(sql);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.content).toBe(sql);
  });

  test(`Single host parameter content test`, () => {
    const document = new Document(`select * from sample where x = :value`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.content).toBe(`select * from sample where x = ?`);
  });

  test(`Single host qualified parameter content test`, () => {
    const document = new Document(`select * from sample where x = :struct.value`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.content).toBe(`select * from sample where x = ?`);
  });

  test(`Double questionmark parameter content test`, () => {
    const document = new Document(`select * from sample where x = ? and y=?`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.content).toBe(`select * from sample where x = ? and y=?`);
  });

  test(`Double host parameter content test`, () => {
    const document = new Document(`select * from sample where x = :value and y=:whoop`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.content).toBe(`select * from sample where x = ? and y=?`);
  });

  test(`Double host qualified parameter content test`, () => {
    const document = new Document(`select * from sample where x = :struct.value or y=:struct.val`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.content).toBe(`select * from sample where x = ? or y=?`);
  });

  test(`Single INTO clause content test`, () => {
    const document = new Document(`select abcd into :myvar from sample where x = 1`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.content).toBe(`select abcd from sample where x = 1`);
  });

  test(`Single INTO clause and host qualified parameter content test`, () => {
    const document = new Document(`select * into :myds from sample where x = :struct.value`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.content).toBe(`select * from sample where x = ?`);
  });

  test(`Double INTO clause and single host qualified parameter content test`, () => {
    const document = new Document(`select x,y into :myds.x,:myds.y from sample where x = :struct.value`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.content).toBe(`select x,y from sample where x = ?`);
  });

  test(`Double INTO clause and single host qualified parameter content test`, () => {
    const document = new Document(`Exec Sql select x,y into :myds.x,:myds.y from sample where x = :struct.value`);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.content).toBe(`select x,y from sample where x = ?`);
  });

  test(`Exec with basic DECLARE`, () => {
    const lines = [
      `EXEC SQL DECLARE empCur CURSOR FOR`,
      `  SELECT EMPNO, FIRSTNME, LASTNAME, JOB`,
      `  FROM EMPLOYEE`,
      `  WHERE WORKDEPT = :DEPTNO`,
    ].join(`\n`);

    const document = new Document(lines);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.parameterCount).toBe(1);
    expect(result.content).toBe([
      `SELECT EMPNO, FIRSTNME, LASTNAME, JOB`,
      `  FROM EMPLOYEE`,
      `  WHERE WORKDEPT = ?`
    ].join(`\n`));
  });

  test(`Exec with basic DECLARE`, () => {
    const lines = [
      `EXEC SQL`,
      `DECLARE cursor_name SCROLL CURSOR FOR`,
      `SELECT column_1, column_2`,
      `FROM table_name`,
      `WHERE column_1 = expression`,
    ].join(`\n`);

    const document = new Document(lines);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.parameterCount).toBe(0);
    expect(result.content).toBe([
      `SELECT column_1, column_2`,
      `FROM table_name`,
      `WHERE column_1 = expression`,
    ].join(`\n`));
  });

  test(`Insert with INTO clause`, () => {
    const content = `INSERT INTO  COOLSTUFF.DLRGPSNEW (DLRID, LOCATION) SELECT ID, QSYS2.ST_POINT(GPSLON, GPSLAT) FROM COOLSTUFF.DLRGPS2`;

    const document = new Document(content);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    const result = document.removeEmbeddedAreas(statement);
    expect(result.parameterCount).toBe(0);
    expect(result.content).toBe(content);
  });

  test('No embedded area on MERGE (issue 348)', () => {
    const content = [
      `merge into sample.employee e`,
      `  using (select *from `,
      `    (values ('000011', 'PAOLO', 'I', 'SALVATORE', 'A00', 1234, 'OPERATOR', 14)) as `,
      `newemp (empno, firstnme, midinit, lastname, workdept, phoneno, job , edlevel))  a`,
      ` on a.empno = e.empno`,
      `when matched then update  `,
      `    set e.firstnme = a.firstnme, e.midinit = a.midinit, e.lastname = a.lastname, `,
      `  e.workdept = a.workdept, e.phoneno = a.phoneno,`,
      `  e.job = a.job, e.edlevel = a.edlevel`,
      `when not matched then `,
      `    insert (empno, firstnme, midinit, lastname, workdept, phoneno, job , edlevel)`,
      ` values (a.empno, a.firstnme, a.midinit, a.lastname, a.workdept, a.phoneno, `,
      `  a.job, a.edlevel);`,
    ].join(`\n`);

    const document = new Document(content);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];
    expect(statement.type).toBe(StatementType.Merge);

    const result = document.removeEmbeddedAreas(statement);
    expect(result.parameterCount).toBe(0);
    expect(result.content + `;`).toBe(content);
    expect(result.changed).toBe(false);
  });

  test('Remove indicator variables', () => {
    const content = [
      `UPDATE CORPDATA.EMPLOYEE`,
      `SET PHONENO = :NEWPHONE:PHONEIND`,
      `WHERE EMPNO = :EMPID;`,
      ``,
      `bind: '3535', '000110';`,
    ].join(`\n`);

    const expectedContent = [
      `UPDATE CORPDATA.EMPLOYEE`,
      `SET PHONENO = ?`,
      `WHERE EMPNO = ?`,
    ].join(`\n`);

    const document = new Document(content);
    const statements = document.statements;
    expect(statements.length).toBe(2);

    const statement = statements[0];
    const result = document.removeEmbeddedAreas(statement);
    console.log(result.content);
    expect(result.parameterCount).toBe(2);
    expect(result.content).toBe(expectedContent);
  });

  test(`Callable blocks`, () => {
    const lines = [
        `call qsys2.create_abcd();`,
        `call qsys2.create_abcd(a, cool(a + b));`,
    ].join(` `);
  
    const document = new Document(lines);
    const statements = document.statements;
  
    expect(statements.length).toBe(2);
  
    const a = statements[0];
    expect(a.type).toBe(StatementType.Call);
  
    const b = statements[1];
    expect(b.type).toBe(StatementType.Call);
  
    const blockA = a.getBlockRangeAt(23);
    expect(blockA).toMatchObject({ start: 5, end: 5 });
  
    const callableA = a.getCallableDetail(23);
    expect(callableA).toBeDefined();
    expect(callableA.parentRef.object.schema).toBe(`qsys2`);
    expect(callableA.parentRef.object.name).toBe(`create_abcd`);
  
    const blockB = a.getBlockRangeAt(24);
    expect(blockB).toMatchObject({ start: 5, end: 5 });
  
    const callableB = a.getCallableDetail(24);
    expect(callableB).toBeDefined();
    expect(callableB.parentRef.object.schema).toBe(`qsys2`);
    expect(callableB.parentRef.object.name).toBe(`create_abcd`);
  
    const blockC = b.getBlockRangeAt(49);
    expect(blockC).toMatchObject({ start: 5, end: 13 });
  
    const callableC = b.getCallableDetail(49, true);
    expect(callableC).toBeDefined();
    expect(callableC.tokens.length).toBe(4);
    expect(callableC.tokens.some(t => t.type === `block` && t.block.length === 3)).toBeTruthy();
    expect(callableC.parentRef.object.schema).toBe(`qsys2`);
    expect(callableC.parentRef.object.name).toBe(`create_abcd`);
  });

  test('Partial parameters 1: Position data for procedure call', () => {
    const sql = `call qsys2.ifs_write('asdasd', )`;

    const document = new Document(sql);
    const statements = document.statements;
  
    expect(statements.length).toBe(1);

    const callableReference: CallableReference = statements[0].getCallableDetail(29);
    expect(callableReference).toBeDefined();
    expect(callableReference.parentRef.object.name).toBe(`ifs_write`);
    expect(callableReference.parentRef.object.schema).toBe(`qsys2`);

    const positionData = getPositionData(callableReference, 29);
    expect(positionData).toBeDefined();

    expect(positionData.currentParm).toBe(1);
    expect(positionData.currentCount).toBe(2);
  });

  test('Partial parameters 1.2: Position data for procedure call', () => {
    const sql = `call qsys2.ifs_write('asdasd', )`;

    const document = new Document(sql);
    const statements = document.statements;
  
    expect(statements.length).toBe(1);

    const callableReference: CallableReference = statements[0].getCallableDetail(31);
    expect(callableReference).toBeDefined();
    expect(callableReference.parentRef.object.name).toBe(`ifs_write`);
    expect(callableReference.parentRef.object.schema).toBe(`qsys2`);

    const positionData = getPositionData(callableReference, 31);
    expect(positionData).toBeDefined();

    expect(positionData.currentParm).toBe(1);
    expect(positionData.currentCount).toBe(2);
  });

  test('Partial parameters 2: Position data for procedure call', () => {
    const sql = `call qsys2.ifs_write('asdasd', 243)`;

    const document = new Document(sql);
    const statements = document.statements;
  
    expect(statements.length).toBe(1);

    const callableReference: CallableReference = statements[0].getCallableDetail(25);
    expect(callableReference).toBeDefined();
    expect(callableReference.parentRef.object.name).toBe(`ifs_write`);
    expect(callableReference.parentRef.object.schema).toBe(`qsys2`);

    const positionData = getPositionData(callableReference, 25);
    expect(positionData).toBeDefined();

    expect(positionData.currentParm).toBe(0);
    expect(positionData.currentCount).toBe(2);
  });

  test('Partial parameters 3: Position data for procedure call', () => {
    const sql = `call qsys2.ifs_write('asdasd', 243, )`;

    const document = new Document(sql);
    const statements = document.statements;
  
    expect(statements.length).toBe(1);

    const callableReference: CallableReference = statements[0].getCallableDetail(25);
    expect(callableReference).toBeDefined();
    expect(callableReference.parentRef.object.name).toBe(`ifs_write`);
    expect(callableReference.parentRef.object.schema).toBe(`qsys2`);

    const positionDataA = getPositionData(callableReference, 25);
    expect(positionDataA).toBeDefined();

    expect(positionDataA.currentParm).toBe(0);
    expect(positionDataA.currentCount).toBe(3);

    const positionDataB = getPositionData(callableReference, 29);
    expect(positionDataB).toBeDefined();

    expect(positionDataB.currentParm).toBe(1);
    expect(positionDataB.currentCount).toBe(3);
  });

  test('Partial parameters 4: Position data for procedure call', () => {
    const sql = `call qsys2.ifs_write('asdasd', 'asdasd', overwrite => 'asdad')`;

    const document = new Document(sql);
    const statements = document.statements;
  
    expect(statements.length).toBe(1);

    const callableReference: CallableReference = statements[0].getCallableDetail(50);
    expect(callableReference).toBeDefined();
    expect(callableReference.parentRef.object.name).toBe(`ifs_write`);
    expect(callableReference.parentRef.object.schema).toBe(`qsys2`);

    const positionDataA = getPositionData(callableReference, 50);
    expect(positionDataA).toBeDefined();

    expect(positionDataA.currentParm).toBe(2);
    expect(positionDataA.currentCount).toBe(3);
  });
});

describe(`Prefix tests`, () => {
  test('CL prefix', () => {
    const content = [
      `-- example`,
      `bar: SELECT A.AUTHORIZATION_NAME as label, SUM(A.STORAGE_USED) AS TOTAL_STORAGE_USED`,
      `  FROM QSYS2.USER_STORAGE A `,
      `  INNER JOIN QSYS2.USER_INFO B ON B.USER_NAME = A.AUTHORIZATION_NAME WHERE B.USER_NAME NOT LIKE 'Q%' `,
      `  GROUP BY A.AUTHORIZATION_NAME, B.TEXT_DESCRIPTION, B.ACCOUNTING_CODE, B.MAXIMUM_ALLOWED_STORAGE`,
      `  ORDER BY TOTAL_STORAGE_USED DESC FETCH FIRST 10 ROWS ONLY`,
    ].join(`\n`);

    const document = new Document(content);
    const statements = document.statements;
    expect(statements.length).toBe(1);

    const statement = statements[0];

    expect(statement.type).toBe(StatementType.Select);
  });
});