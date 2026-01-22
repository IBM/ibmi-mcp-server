/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, expect, test } from "vitest";
import Document from "../../../src/ibmi-mcp-server/utils/language/document";

const parserScenarios = describe.each([
  { newDoc: (content: string) => new Document(content), isFormatted: false },
]);

parserScenarios(`Block statement tests`, ({ newDoc, isFormatted }) => {
  test("Block start tests", () => {
    const lines = [
      `CREATE ALIAS "TestDelimiters"."Delimited Alias" FOR "TestDelimiters"."Delimited Table";`,
      ``,
      `CREATE FUNCTION "TestDelimiters"."Delimited Function" ("Delimited Parameter" INTEGER) `,
      `RETURNS INTEGER LANGUAGE SQL BEGIN RETURN "Delimited Parameter"; END;`,
      ``,
      `CREATE PROCEDURE "TestDelimiters"."Delimited Procedure" (INOUT "Delimited Parameter" INTEGER) `,
      `LANGUAGE SQL BEGIN SET "Delimited Parameter" = 13; END;`,
    ].join(`\n`);

    const doc = newDoc(lines);

    // CREATE, CREATE, RETURN, END, CREATE, SET, END
    expect(doc.statements.length).toBe(7);

    const aliasDef = doc.statements[0];
    expect(aliasDef.isCompoundStart()).toBeFalsy();

    const functionDef = doc.statements[1];
    expect(functionDef.isCompoundStart()).toBeTruthy();

    const procedureDef = doc.statements[4];
    expect(procedureDef.isCompoundStart()).toBeTruthy();
  });

  test("Compound statement test", () => {
    const lines = [
      `CREATE ALIAS "TestDelimiters"."Delimited Alias" FOR "TestDelimiters"."Delimited Table";`,
      ``,
      `CREATE FUNCTION "TestDelimiters"."Delimited Function" ("Delimited Parameter" INTEGER) `,
      `RETURNS INTEGER LANGUAGE SQL BEGIN RETURN "Delimited Parameter"; END;`,

      `BEGIN`,
      `  DECLARE already_exists SMALLINT DEFAULT 0;`,
      `  DECLARE dup_object_hdlr CONDITION FOR SQLSTATE '42710';`,
      `  DECLARE CONTINUE HANDLER FOR dup_object_hdlr`,
      `      SET already_exists = 1;`,
      `  CREATE TABLE table1(col1 INT);`,
      `  IF already_exists > 0`,
      `  THEN`,
      `      DELETE FROM table1;`,
      `  END IF;`,
      `END;`,
      ``,
      `CREATE PROCEDURE "TestDelimiters"."Delimited Procedure" (INOUT "Delimited Parameter" INTEGER) `,
      `LANGUAGE SQL BEGIN SET "Delimited Parameter" = 13; END;`,
    ].join(`\n`);

    const doc = newDoc(lines);

    const t = doc.statements.length;

    const aliasDef = doc.statements[0];
    expect(aliasDef.isCompoundStart()).toBeFalsy();

    const functionDef = doc.statements[1];
    expect(functionDef.isCompoundStart()).toBeTruthy();

    const functionEnd = doc.statements[3];
    expect(functionEnd.isCompoundEnd()).toBeTruthy();

    const beginBlock = doc.statements[4];
    expect(beginBlock.isCompoundStart()).toBeTruthy();
  });

  test("Statement groups", () => {
    const compoundStatement = [
      `BEGIN`,
      `  DECLARE already_exists SMALLINT DEFAULT 0;`,
      `  DECLARE dup_object_hdlr CONDITION FOR SQLSTATE '42710';`,
      `  DECLARE CONTINUE HANDLER FOR dup_object_hdlr`,
      `      SET already_exists = 1;`,
      `  CREATE TABLE table1(col1 INT);`,
      `  IF already_exists > 0`,
      `  THEN`,
      `      DELETE FROM table1;`,
      `  END IF;`,
      `END`,
    ].join(`\r\n`);

    const lines = [
      `CREATE ALIAS "TestDelimiters"."Delimited Alias" FOR "TestDelimiters"."Delimited Table";`,
      ``,
      `CREATE FUNCTION "TestDelimiters"."Delimited Function" ("Delimited Parameter" INTEGER) `,
      `RETURNS INTEGER LANGUAGE SQL BEGIN RETURN "Delimited Parameter"; END;`,
      compoundStatement + `;`,
      ``,
      `CREATE PROCEDURE "TestDelimiters"."Delimited Procedure" (INOUT "Delimited Parameter" INTEGER) `,
      `LANGUAGE SQL BEGIN SET "Delimited Parameter" = 13; END;`,
    ].join(`\r\n`);

    const doc = newDoc(lines);

    const groups = doc.getStatementGroups();

    expect(groups.length).toBe(4);

    const aliasStatement = groups[0];
    const aliasSubstring = doc.content.substring(
      aliasStatement.range.start,
      aliasStatement.range.end,
    );
    expect(aliasSubstring).toBe(
      `CREATE ALIAS "TestDelimiters"."Delimited Alias" FOR "TestDelimiters"."Delimited Table"`,
    );

    const functionStatement = groups[1];
    const functionSubstring = doc.content.substring(
      functionStatement.range.start,
      functionStatement.range.end,
    );

    if (isFormatted) {
      expect(functionSubstring).toBe(
        [
          `CREATE FUNCTION "TestDelimiters"."Delimited Function"(`,
          `    "Delimited Parameter" INTEGER`,
          `) RETURNS INTEGER LANGUAGE SQL BEGIN`,
          `    RETURN "Delimited Parameter";`,
          `END`,
        ].join(`\r\n`),
      );
    } else {
      expect(functionSubstring).toBe(
        [
          `CREATE FUNCTION "TestDelimiters"."Delimited Function" ("Delimited Parameter" INTEGER) `,
          `RETURNS INTEGER LANGUAGE SQL BEGIN RETURN "Delimited Parameter"; END`,
        ].join(`\r\n`),
      );
    }
    const beginStatement = groups[2];
    expect(beginStatement.statements.length).toBe(9);
    const compoundSubstring = doc.content.substring(
      beginStatement.range.start,
      beginStatement.range.end,
    );

    if (isFormatted) {
      expect(compoundSubstring).toBe(
        [
          `BEGIN`,
          `    DECLARE already_exists SMALLINT DEFAULT 0;`,
          `    DECLARE dup_object_hdlr CONDITION FOR SQLSTATE '42710';`,
          `    DECLARE CONTINUE HANDLER FOR dup_object_hdlr SET already_exists = 1;`,
          `    CREATE TABLE table1(`,
          `        col1 INT`,
          `    );`,
          `    IF already_exists > 0 THEN;`,
          `        DELETE FROM table1;`,
          `    END IF;`,
          `END`,
        ].join(`\r\n`),
      );
    } else {
      expect(compoundSubstring).toBe(compoundStatement);
    }
  });
});

parserScenarios(`Definition tests`, ({ newDoc }) => {
  test(`Alias, function, procedure`, () => {
    const lines = [
      `CREATE ALIAS "TestDelimiters"."Delimited Alias" FOR "TestDelimiters"."Delimited Table";`,
      ``,
      `CREATE FUNCTION "TestDelimiters"."Delimited Function" ("Delimited Parameter" INTEGER) `,
      `RETURNS INTEGER LANGUAGE SQL BEGIN RETURN "Delimited Parameter"; END;`,
      ``,
      `CREATE PROCEDURE "TestDelimiters"."Delimited Procedure" (INOUT "Delimited Parameter" INTEGER) `,
      `LANGUAGE SQL BEGIN SET "Delimited Parameter" = 13; END;`,
    ].join(`\n`);

    const doc = newDoc(lines);

    const defs = doc.getDefinitions();

    expect(defs.length).toBe(3);

    const aliasDef = defs[0];
    expect(aliasDef.createType).toBe(`ALIAS`);
    expect(aliasDef.object.schema).toBe(`"TestDelimiters"`);
    expect(aliasDef.object.name).toBe(`"Delimited Alias"`);
    expect(aliasDef.children.length).toBe(0);
  });

  test(`Procedure with children`, () => {
    const lines = [
      `-- SELECT * FROM`,
      `-- TABLE(QSYS2.PARSE_STATEMENT('SELECT ORDNO,ORDSTS FROM PRODLIB.ORDHDR'))`,
      `-- AS A`,
      ``,
      `CREATE OR REPLACE PROCEDURE ILEDITOR.TELLMEWHATICANDOBETTER(IN QUERY VARCHAR(16000))`,
      `DYNAMIC RESULT SETS 1 `,
      `BEGIN`,
      `  DECLARE tableCount integer;`,
      `  DECLARE columnClauseCount integer default 0;`,
      `  DECLARE hadTables Char(1);`,
      ``,
      `  DECLARE currentSchema varchar(128);`,
      `  DECLARE currentObject varchar(128);`,
      ``,
      `  DECLARE ResultSet CURSOR FOR`,
      `    SELECT * from session.suggestions;`,
      ``,
      `  OPEN ResultSet;`,
      `  SET RESULT SETS CURSOR ResultSet;`,
      `END;`,
    ].join(`\r\n`);

    const doc = newDoc(lines);

    const defs = doc.getDefinitions();

    expect(defs.length).toBe(1);

    const procDef = defs[0];
    expect(procDef.createType).toBe(`PROCEDURE`);
    expect(procDef.object.schema).toBe(`ILEDITOR`);
    expect(procDef.object.name).toBe(`TELLMEWHATICANDOBETTER`);

    expect(procDef.children.length).toBe(6);

    const children = procDef.children;

    const tableCount = children[0];
    expect(tableCount.object.name).toBe(`tableCount`);
    expect(tableCount.createType).toBe(`integer`);

    const columnClauseCount = children[1];
    expect(columnClauseCount.object.name).toBe(`columnClauseCount`);
    expect(columnClauseCount.createType).toBe(`integer`);

    const hadTables = children[2];
    expect(hadTables.object.name).toBe(`hadTables`);
    expect(hadTables.createType).toBe(`Char(1)`);

    const ResultSet = children[5];
    expect(ResultSet.object.name).toBe(`ResultSet`);
    expect(ResultSet.createType).toBe(`Cursor`);
  });

  test(`Function with children: Handlers, variable`, () => {
    const lines = [
      `CREATE FUNCTION SYSTOOLS/SPOOLED_FILE_DATA ( `,
      `	JOB_NAME VARCHAR(28) , `,
      `	SPOOLED_FILE_NAME VARCHAR(10) DEFAULT  'QPJOBLOG'  , `,
      `	SPOOLED_FILE_NUMBER VARCHAR(6) DEFAULT  '*LAST'  ) `,
      `	RETURNS TABLE ( `,
      `	ORDINAL_POSITION INTEGER , `,
      `	SPOOLED_DATA VARCHAR(200) FOR SBCS DATA )   `,
      `	LANGUAGE SQL `,
      `	SPECIFIC SYSTOOLS/SPOOL_FILE `,
      `	NOT DETERMINISTIC `,
      `	MODIFIES SQL DATA `,
      `	CALLED ON NULL INPUT `,
      `	SYSTEM_TIME SENSITIVE NO `,
      `	SET OPTION  ALWBLK = *ALLREAD , `,
      `	ALWCPYDTA = *OPTIMIZE , `,
      `	COMMIT = *NONE , `,
      `	DECRESULT = (31, 31, 00) , `,
      `	DFTRDBCOL = QSYS2 , `,
      `	DLYPRP = *NO , `,
      `	DYNDFTCOL = *NO , `,
      `	DYNUSRPRF = *USER , `,
      `	MONITOR = *SYSTEM , `,
      `	SRTSEQ = *HEX   `,
      `	BEGIN `,

      `DECLARE ERROR_V BIGINT DEFAULT 0 ; `,

      `BEGIN `,
      `DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET ERROR_V = 1 ; `,
      `CALL QSYS2 / QCMDEXC ( `,
      `'QSYS/CRTPF FILE(QTEMP/QIBM_SFD) RCDLEN(200) ' CONCAT `,
      `' MBR(*NONE) MAXMBRS(*NOMAX) SIZE(*NOMAX)' ) ; `,
      `END ; `,
      ``,
      `BEGIN `,
      `DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET ERROR_V = 2 ; `,
      `CALL QSYS2 / QCMDEXC ( 'QSYS/CPYSPLF     FILE(' CONCAT SPOOLED_FILE_NAME CONCAT `,
      `') TOFILE(QTEMP/QIBM_SFD) JOB(' CONCAT JOB_NAME CONCAT `,
      `') MBROPT(*REPLACE) SPLNBR(' CONCAT SPOOLED_FILE_NUMBER CONCAT ') OPNSPLF(*YES)' ) ; `,
      `END ; `,

      `IF ERROR_V > 1 THEN `,
      `SIGNAL SQLSTATE '42704' `,
      `SET MESSAGE_TEXT = 'FAILURE ON CPYSPLF' ; `,
      `END IF ; `,
      `RETURN SELECT RRN ( JL ) , JL . * FROM QTEMP / QIBM_SFD JL ORDER BY RRN ( JL ) ASC ; `,

      `END  ; `,
    ].join(`\n`);

    const doc = newDoc(lines);

    const groups = doc.getStatementGroups();
    expect(groups.length).toBe(1);

    const defs = doc.getDefinitions();
    expect(defs.length).toBe(1);

    const theFunction = defs[0];

    expect(theFunction.createType).toBe(`FUNCTION`);
    expect(theFunction.object.schema).toBe(`SYSTOOLS`);
    expect(theFunction.object.name).toBe(`SPOOLED_FILE_DATA`);

    expect(theFunction.children.length).toBe(3);

    const children = theFunction.children;

    const bigInt = children[0];
    expect(bigInt.object.name).toBe(`ERROR_V`);
    expect(bigInt.createType).toBe(`BIGINT`);

    const handlerA = children[1];
    expect(handlerA.object.name).toBe(`CONTINUE`);
    expect(handlerA.createType).toBe(`Handler`);

    const handlerB = children[2];
    expect(handlerB.object.name).toBe(`CONTINUE`);
    expect(handlerB.createType).toBe(`Handler`);
  });
});

test(`Procedure with depths`, () => {
  const lines = [
    `create or replace function "IS_VALID_TZ"`,
    `  (`,
    `    "P_SAP_CLIENT"         VARGRAPHIC(3) CCSID 13488, `,
    `    "P_SAP_TZ"             VARGRAPHIC(6) CCSID 13488`,
    `  )`,
    `  RETURNS INTEGER`,
    `  LANGUAGE SQL`,
    `  SPECIFIC "IS_VALID_TZ"`,
    `  /* Because of SQL usage */`,
    `  /**/STATEMENT/**/ DETERMINISTIC`,
    `  NO EXTERNAL ACTION`,
    `  READS SQL DATA`,
    `  CALLED ON NULL INPUT`,
    `  INHERIT SPECIAL REGISTERS`,
    `  STATIC DISPATCH`,
    `  /* Because of SQL usage */`,
    `  FENCED`,
    `  ALLOW PARALLEL`,
    `  NOT SECURED`,
    `  /* Because of SQL usage */`,
    `  CONCURRENT ACCESS RESOLUTION USE CURRENTLY COMMITTED`,
    `  `,
    `  SET OPTION `,
    `    DECFLTRND = *HALFEVEN,`,
    `    DECRESULT = (31, 31, 0),`,
    `    TGTRLS = V7R2M0,`,
    `    MONITOR = *SYSTEM,`,
    `    USRPRF = *USER,`,
    `    /* Inlining requires datetime formats and decimal */`,
    `    /* separator to match the settings of the query   */`,
    `    DATFMT = *USA,`,
    `    DATSEP = '/',`,
    `    TIMFMT = *USA,`,
    `    TIMSEP = ':',`,
    `    DECMPT = *PERIOD,`,
    `    /* Workaround for missing 'use isolation level of caller' */`,
    `    COMMIT = *CS`,
    `  `,
    `  BEGIN`,
    `  /*                                                                   */`,
    `  /* (C) Copyright SAP AG, Walldorf 2016, Version 01.01                */`,
    `  /*                                                                   */`,
    `  /*& Version History:                                                &*/`,
    `  /*& V01.00 - Initial Implementation                                 &*/`,
    `  /*& V01.01 - STATEMENT DETERMINISTIC Option                         &*/`,
    `  /*&                                                                 &*/`,
    `  `,
    `    DECLARE "L_SAP_ZONERULE" VARGRAPHIC(6) CCSID 13488 DEFAULT NULL;`,
    `    DECLARE "L_SAP_UTCDIFF" VARGRAPHIC(6) CCSID 13488 DEFAULT NULL;`,
    `    DECLARE "L_SAP_UTCSIGN" VARGRAPHIC(1) CCSID 13488 DEFAULT NULL;`,
    `    DECLARE "L_SAP_DSTDIFF" VARGRAPHIC(6) CCSID 13488 DEFAULT NULL;`,
    `    DECLARE "L_SAP_DSTRULE" VARGRAPHIC(6) CCSID 13488 DEFAULT NULL;`,
    `    DECLARE "L_SAP_YEARFROM" VARGRAPHIC(4) CCSID 13488;`,
    `    DECLARE "L_EXISTS_VAR_DATE" INTEGER DEFAULT NULL;`,
    `    DECLARE "L_EXISTS_FIXED_DATE" INTEGER DEFAULT NULL;`,
    `    `,
    `    IF ( "P_SAP_CLIENT" IS NULL OR "P_SAP_TZ" IS NULL ) THEN`,
    `      RETURN 0;`,
    `    END IF;`,
    `    `,
    `    IF ( "P_SAP_TZ" = ' ' ) THEN`,
    `      RETURN 1;`,
    `    END IF;`,
    `    `,
    `    SET ( "L_SAP_ZONERULE", "L_SAP_DSTRULE" ) = (`,
    `        SELECT "ZONERULE", "DSTRULE" FROM "TTZZ" `,
    `               WHERE "CLIENT" = "P_SAP_CLIENT" AND `,
    `                     "TZONE" = "P_SAP_TZ" );`,
    `    IF ( "L_SAP_ZONERULE" IS NULL OR "L_SAP_DSTRULE" IS NULL ) THEN`,
    `      RETURN 0;`,
    `    END IF;`,
    `    `,
    `    SET ( "L_SAP_UTCDIFF", "L_SAP_UTCSIGN" ) = (`,
    `        SELECT "UTCDIFF", "UTCSIGN" FROM "TTZR" `,
    `               WHERE "CLIENT" = "P_SAP_CLIENT" and `,
    `                     "ZONERULE" = "L_SAP_ZONERULE" );`,
    `   `,
    `    /* Includes "L_SAP_UTCDIFF" = NULL */`,
    `    IF ( TIMS_IS_VALID( "L_SAP_UTCDIFF" ) = 0 OR `,
    `         "L_SAP_UTCSIGN" NOT IN( '+', '-' ) ) THEN`,
    `      RETURN 0;`,
    `    END IF;`,
    `    `,
    `    /* DELTA-UTC = L_SAP_UTCSIGN * L_SAP_UTCDIFF */`,
    `    `,
    `    SET "L_SAP_DSTDIFF" = (`,
    `        SELECT "DSTDIFF" FROM "TTZD" `,
    `               WHERE "CLIENT" = "P_SAP_CLIENT" AND `,
    `                     "DSTRULE" = "L_SAP_DSTRULE" );`,
    `  `,
    `    /* Includes "L_SAP_DSTDIFF" = NULL */`,
    `    IF ( TIMS_IS_VALID( "L_SAP_DSTDIFF" ) = 0 ) THEN`,
    `      RETURN 0;`,
    `    END IF;`,
    `      `,
    `    /* DELTA-DST = L_SAP_DSTDIFF */`,
    `    `,
    `    /****** Check L_SAP_DSTDIFF value *****/`,
    `    `,
    `    IF ( "L_SAP_DSTDIFF" = '000000' ) THEN`,
    `      RETURN 1;`,
    `    END IF;`,
    `    `,
    `    /* Is there a fixed DST switch date?  */`,
    `    /* And if so, are all of those valid? */`,
    `    BEGIN `,
    `      /* INTEGER CAST can lead to SQL+/-420 ("Character in CAST    */`,
    `      /* argument not valid." --> is invalid entry.                */`,
    `      /* Put INTEGER CAST into SELECT list to make sure that it is */`,
    `      /* called only for data that matches the WHERE condition.    */`,
    `      DECLARE CONTINUE HANDLER FOR SQLSTATE '22018' RETURN 0;`,
    `      DECLARE CONTINUE HANDLER FOR SQLSTATE '01565' RETURN 0;`,
    `      SET "L_EXISTS_FIXED_DATE" = (`,
    `          SELECT `,
    `            SUM ( CASE `,
    `                    WHEN ( INTEGER("YEARACT") NOT BETWEEN 0 AND 9999`,
    `                           OR TIMS_IS_VALID("TIMEFROM") = 0`,
    `                           OR TIMS_IS_VALID("TIMETO") = 0`,
    `                           OR DATS_IS_VALID("DATEFROM") = 0`,
    `                           OR DATS_IS_VALID("DATETO") = 0`,
    `                           OR DATS_ADD_DAYS("DATEFROM", 1, 'NULL')`,
    `                              >= "DATETO"`,
    `                           OR "YEARACT"`,
    `                              <> INTEGER(SUBSTRING("DATEFROM", 1, 4))`,
    `                         )`,
    `                    THEN 1`,
    `                    ELSE 0`,
    `                  END`,
    `                )`,
    `                FROM "TTZDF" `,
    `                WHERE "CLIENT" = "P_SAP_CLIENT" AND `,
    `                      "DSTRULE" = "L_SAP_DSTRULE" );`,
    `    END;          `,
    `               `,
    `    IF ( "L_EXISTS_FIXED_DATE" > 0 ) THEN`,
    `      /* Some entries exist, but not all of them are valid */`,
    `      RETURN 0;`,
    `    ELSE`,
    `      /* 1) No fixed DST switch date exists                      */`,
    `      /*    ("L_EXISTS_FIXED_DATE" IS NULL), or                  */`,
    `      /* 2) Some fixed DST dates exist and all of them are valid */ `,
    `      /* --> Check for variable DST switch dates                 */ `,
    `      BEGIN `,
    `        /* INTEGER CAST can lead to SQL+/-420 ("Character in CAST    */`,
    `        /* argument not valid." --> is invalid entry.                */`,
    `        /* Put INTEGER CAST into SELECT list to make sure that it is */`,
    `        /* called only for data that matches the WHERE condition.    */`,
    `        DECLARE CONTINUE HANDLER FOR SQLSTATE '22018' RETURN 0;`,
    `        LARE CONTINUE HANDLER FOR SQLSTATE '01565' RETURN 0;`,
    `        SET "L_EXISTS_VAR_DATE" = ( `,
    `            SELECT `,
    `              SUM ( CASE `,
    `                      WHEN (INTEGER("YEARFROM") NOT BETWEEN 1 AND 9999 `,
    `                           OR INTEGER("MONTHFROM") NOT BETWEEN 1 AND 12`,
    `                           OR INTEGER("MONTHTO") NOT BETWEEN 1 AND 12`,
    `                           OR INTEGER("WEEKDFROM") NOT BETWEEN 1 AND 7`,
    `                           OR INTEGER("WEEKDCFROM") NOT BETWEEN 1 AND 5`,
    `                           OR INTEGER("WEEKDTO") NOT BETWEEN 1 AND 7 `,
    `                           OR INTEGER("WEEKDCTO") NOT BETWEEN 1 AND 5`,
    `                           OR TIMS_IS_VALID("TIMEFROM") = 0`,
    `                           OR TIMS_IS_VALID("TIMETO") = 0`,
    `                          )`,
    `                     THEN 1`,
    `                     ELSE 0`,
    `                   END`,
    `                 )`,
    `                 FROM "TTZDV" `,
    `                 WHERE "CLIENT" = "P_SAP_CLIENT" AND `,
    `                       "DSTRULE" = "L_SAP_DSTRULE" );`,
    `      END;`,
    `      IF ( "L_EXISTS_VAR_DATE" IS NULL ) THEN`,
    `        IF ( "L_EXISTS_FIXED_DATE" IS NULL ) THEN`,
    `          /* No variable and no fixed DST switch date exist */`,
    `          RETURN 0;`,
    `        ELSE`,
    `          /* No variable DST switch date, but a fixed switch date - ok */`,
    `          RETURN 1;`,
    `        END IF;`,
    `      ELSE`,
    `        IF ( "L_EXISTS_VAR_DATE" = 0 ) THEN`,
    `          /* All variable DST switch dates are valid, too */`,
    `          RETURN 1;`,
    `        ELSE`,
    `          /* At least one invalid variable DST switch date */`,
    `          RETURN 0;`,
    `        END IF;`,
    `      END IF;      `,
    `    END IF;   `,
    `    `,
    `  END;`,
  ].join(`\n`);

  const doc = new Document(lines);

  const groups = doc.getStatementGroups();
  expect(groups.length).toBe(1);
});

test("CREATE statements", () => {
  const lines = [
    `CREATE TABLE temp_t1`,
    `(PK BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY,`,
    ` RB TIMESTAMP(12) NOT NULL GENERATED ALWAYS AS ROW BEGIN,`,
    ` RE TIMESTAMP(12) NOT NULL GENERATED ALWAYS AS ROW END,`,
    ` TS TIMESTAMP(12) NOT NULL GENERATED ALWAYS AS TRANSACTION START ID,`,
    ` C1 INT,`,
    ` C2 char(10),`,
    ` C3 NOT NULL GENERATED ALWAYS FOR EACH ROW  ON UPDATE AS ROW CHANGE TIMESTAMP IMPLICITLY HIDDEN,`,
    ` PERIOD SYSTEM_TIME (RB, RE)`,
    `);`,
    ``,
    ``,
    `reate or replace view temp_v1t1 as select * from temp_t1 where RB<>RE with check option;`,
    ``,
    `nsert into temp_v1t1(c1, c2) values(1,'first part');`,
  ].join(`\n`);

  const doc = new Document(lines);

  const groups = doc.getStatementGroups();
  expect(groups.length).toBe(3);
});

test(`ALTER with BEGIN`, () => {
  const lines = [
    `ALTER TABLE mylongtable1`,
    `  ADD COLUMN ib TIMESTAMP(12) NOT NULL GENERATED ALWAYS AS ROW BEGIN`,
    `  ADD COLUMN ie TIMESTAMP(12) NOT NULL GENERATED ALWAYS AS ROW END`,
    `  ADD COLUMN tid TIMESTAMP(12) NOT NULL GENERATED ALWAYS AS TRANSACTION START`,
    `  ID`,
    `  ADD PERIOD SYSTEM_TIME (ib, ie);`,
  ].join(`\n`);

  const doc = new Document(lines);
  const groups = doc.getStatementGroups();
  expect(groups.length).toBe(1);
});
