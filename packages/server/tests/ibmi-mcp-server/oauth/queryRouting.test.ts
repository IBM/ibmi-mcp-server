/**
 * @fileoverview Tests for where a tool's SQL runs. In built-in OAuth mode the
 * built-in tools and the YAML tools are driven against the in-process fake
 * Mapepire server through a real grant manager: every statement must arrive
 * on the connection of the caller's own sign-on, and nothing may reach a
 * connection pool. Every credential is made up; no IBM i is involved.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

// A page is 5 rows and a paginated result stops at 12 in this file. No test
// may construct a mapepire-js pool: the one that does fails here.
const { Pool } = vi.hoisted(() => {
  process.env.IBMI_PAGINATION_DEFAULT_PAGE_SIZE = "5";
  process.env.IBMI_PAGINATION_MAX_ROWS = "12";
  return {
    Pool: vi.fn(function () {
      throw new Error("a mapepire-js pool was constructed");
    }),
  };
});

vi.mock("@ibm/mapepire-js", () => ({
  default: { Pool, getRootCertificate: vi.fn() },
}));

import { config } from "../../../src/config/index.js";
import { loadSQLTools } from "../../../src/ibmi-mcp-server/index.js";
import {
  GRANT_TOKEN_PREFIX,
  type GrantManager,
  type QueryRouterApi,
} from "../../../src/ibmi-mcp-server/oauth/contracts.js";
import { createGrantManager } from "../../../src/ibmi-mcp-server/oauth/grantManager.js";
import { createMapepireClient } from "../../../src/ibmi-mcp-server/oauth/mapepireSession.js";
import { AuthenticatedPoolManager } from "../../../src/ibmi-mcp-server/services/authenticatedPoolManager.js";
import { IBMiConnectionPool } from "../../../src/ibmi-mcp-server/services/connectionPool.js";
import {
  executeQuery,
  executeQueryWithPagination,
  setGrantQueryExecutor,
} from "../../../src/ibmi-mcp-server/services/queryRouter.js";
import { SourceManager } from "../../../src/ibmi-mcp-server/services/sourceManager.js";
import { executeSqlTool } from "../../../src/ibmi-mcp-server/tools/executeSql.tool.js";
import { generateSqlTool } from "../../../src/ibmi-mcp-server/tools/generateSql.tool.js";
import { getRelatedObjectsTool } from "../../../src/ibmi-mcp-server/tools/getRelatedObjects.tool.js";
import { getTableColumnsTool } from "../../../src/ibmi-mcp-server/tools/getTableColumns.tool.js";
import { listSchemasTool } from "../../../src/ibmi-mcp-server/tools/listSchemas.tool.js";
import { listTablesInSchemaTool } from "../../../src/ibmi-mcp-server/tools/listTablesInSchema.tool.js";
import { validateQueryTool } from "../../../src/ibmi-mcp-server/tools/validateQuery.tool.js";
import { ConfigParser } from "../../../src/ibmi-mcp-server/utils/config/configParser.js";
import { SQLToolFactory } from "../../../src/ibmi-mcp-server/utils/config/toolFactory.js";
import { ToolProcessor } from "../../../src/ibmi-mcp-server/utils/config/toolProcessor.js";
import type { SdkContext } from "../../../src/mcp-server/tools/utils/types.js";
import { authContext } from "../../../src/mcp-server/transports/auth/lib/authContext.js";
import type { AuthInfo } from "../../../src/mcp-server/transports/auth/lib/authTypes.js";
import { JsonRpcErrorCode } from "../../../src/types-global/errors.js";
import { requestContextService } from "../../../src/utils/internal/requestContext.js";
import {
  FAKE_PASSWORD,
  startFakeMapepire,
  type FakeMapepire,
} from "./fakeMapepire.js";

const CLIENT_ID = "https://client.example/oauth/metadata.json";
const REDIRECT = "http://127.0.0.1:33418/callback";
const ADDRESS = "10.1.2.3";
const VERIFIER = "pkce-verifier-".repeat(4);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
/** The IBM i of this file's configuration. Nothing ever connects to it. */
const IBMI_HOST = "ibmi.example.test";
const CUSTOMER_QUERY = "SELECT CUSNUM FROM QIWS.QCUSTCDT";
const UNAUTHORIZED = { code: JsonRpcErrorCode.Unauthorized };

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ ID: index + 1 }));

/** What the fake answers, by a fragment of the statement. */
const STATEMENTS = [
  {
    match: "USER_INFO_BASIC",
    reply: {
      rows: [
        {
          STATUS: "*ENABLED",
          PASSWORD_CHANGE_DATE: "2026-01-01 00:00:00.000000",
          SPECIAL_AUTHORITIES: null,
        },
      ],
    },
  },
  // execute_sql asks for the statement type before it runs anything.
  {
    match: "DISTINCT SQL_STATEMENT_TYPE",
    reply: { rows: [{ SQL_STATEMENT_TYPE: "QUERY" }] },
  },
  // validate_query: a table, one of its columns and a function to look up.
  {
    match: "QSYS2.PARSE_STATEMENT",
    reply: {
      rows: [
        { NAME_TYPE: "TABLE", SCHEMA: "QIWS", NAME: "QCUSTCDT" },
        {
          NAME_TYPE: "COLUMN",
          SCHEMA: "QIWS",
          NAME: "QCUSTCDT",
          COLUMN_NAME: "CUSNUM",
        },
        { NAME_TYPE: "FUNCTION", SCHEMA: "QSYS2", NAME: "NOSUCHFN" },
      ],
    },
  },
  {
    match: "FROM QSYS2.SYSTABLES WHERE",
    reply: { rows: [{ TABLE_SCHEMA: "QIWS", TABLE_NAME: "QCUSTCDT" }] },
  },
  {
    match: "FROM QSYS2.SYSCOLUMNS WHERE",
    reply: {
      rows: [
        {
          TABLE_SCHEMA: "QIWS",
          TABLE_NAME: "QCUSTCDT",
          COLUMN_NAME: "CUSNUM",
        },
      ],
    },
  },
  {
    match: "QSYS2.GENERATE_SQL",
    reply: { rows: [{ SRCDTA: "CREATE TABLE QIWS.QCUSTCDT (CUSNUM INT)" }] },
  },
  { match: "FROM QSYS2.SYSSCHEMAS", reply: { rows: rows(200) } },
  { match: "FROM QSYS2.SYSCOLUMNS2", reply: { rows: rows(11) } },
  { match: "FROM QIWS.TWENTYROWS", reply: { rows: rows(20) } },
  { match: CUSTOMER_QUERY, reply: { rows: [{ CUSNUM: 938472 }] } },
];

/** The seven built-in tools, how to call each and the statements it runs. */
const BUILTIN_TOOLS: Array<[string, AnyTool, unknown, string[]]> = [
  ["list_schemas", listSchemasTool, {}, ["FROM QSYS2.SYSSCHEMAS"]],
  [
    "list_tables_in_schema",
    listTablesInSchemaTool,
    { schema_name: "QIWS" },
    ["FROM QSYS2.SYSTABLES T"],
  ],
  [
    "get_table_columns",
    getTableColumnsTool,
    { schema_name: "QIWS", table_name: "QCUSTCDT" },
    ["FROM QSYS2.SYSCOLUMNS2"],
  ],
  [
    "get_related_objects",
    getRelatedObjectsTool,
    { library_name: "QIWS", file_name: "QCUSTCDT" },
    ["SYSTOOLS.RELATED_OBJECTS"],
  ],
  [
    "generate_sql",
    generateSqlTool,
    { object_name: "QCUSTCDT", object_library: "QIWS", object_type: "TABLE" },
    ["CALL QSYS2.GENERATE_SQL"],
  ],
  [
    "validate_query",
    validateQueryTool,
    { sql_statement: CUSTOMER_QUERY },
    [
      "QSYS2.PARSE_STATEMENT",
      "FROM QSYS2.SYSTABLES WHERE",
      "FROM QSYS2.SYSROUTINES WHERE",
      "FROM QSYS2.SYSCOLUMNS WHERE",
    ],
  ],
  [
    "execute_sql",
    executeSqlTool,
    { sql: CUSTOMER_QUERY },
    ["DISTINCT SQL_STATEMENT_TYPE", CUSTOMER_QUERY],
  ],
];

/** A source whose credentials are the variables of the service profile. */
const source = (name: string, host: string) => `
  ${name}:
    host: ${host}
    user: \${DB2i_USER}
    password: \${DB2i_PASS}
`;

const YAML_SOURCE = `sources:${source("ibmi-system", "${DB2i_HOST}")}`;

const YAML_TOOLS = `
tools:
  customer_by_number:
    source: ibmi-system
    description: "One customer"
    statement: "${CUSTOMER_QUERY} WHERE CUSNUM = :number"
    parameters:
      - name: number
        type: integer
        required: true
        description: "Customer number"
  twenty_rows:
    source: ibmi-system
    description: "Every row"
    statement: "SELECT ID FROM QIWS.TWENTYROWS"
    fetchAllRows: true
  three_rows:
    source: ibmi-system
    description: "The first rows"
    statement: "SELECT ID FROM QIWS.TWENTYROWS"
    rowsToFetch: 3
`;

/** A built-in tool, loosely: each has its own input and output types. */
interface AnyTool {
  inputSchema: { parse(input: unknown): unknown };
  logic(
    input: never,
    context: ReturnType<typeof requestContextService.createRequestContext>,
    sdkContext: SdkContext,
  ): Promise<unknown>;
}

interface ToolResult {
  success: boolean;
  error?: { code: string; message: string };
  [field: string]: unknown;
}

const context = requestContextService.createRequestContext({
  operation: "QueryRoutingTest",
});

const original = {
  mcpAuthMode: config.mcpAuthMode,
  oauthIssuerUrl: config.oauthIssuerUrl,
  toolsYamlPath: config.toolsYamlPath,
  selectedToolsets: config.selectedToolsets,
  yamlAutoReload: config.yamlAutoReload,
};
const originalHost = config.oauth.mapepire.host;
const originalEnv = {
  DB2i_HOST: process.env.DB2i_HOST,
  DB2i_PORT: process.env.DB2i_PORT,
  DB2i_USER: process.env.DB2i_USER,
  DB2i_PASS: process.env.DB2i_PASS,
};

type Spy = MockInstance<(...args: never[]) => unknown>;

let tmpRoot: string;
let fileCount = 0;
let fake: FakeMapepire;
let grants: GrantManager;
/** Everything that leads to a connection pool. */
let pools: {
  serviceInstance: Spy;
  serviceQuery: Spy;
  servicePaginated: Spy;
  sourceInstance: Spy;
  registerSource: Spy;
  authenticatedInstance: Spy;
};

/** Writes a YAML tools file and returns its path. */
function yamlFile(content: string): string {
  const path = join(tmpRoot, `tools-${fileCount++}.yaml`);
  writeFileSync(path, content);
  return path;
}

/** Why the server would not start with this tools file, or "" if it would. */
function startupError(path: string): Promise<string> {
  config.toolsYamlPath = path;
  return loadSQLTools().then(
    () => "",
    (error: Error) => error.message,
  );
}

/** Calls a built-in tool the way its handler does. */
function call(tool: AnyTool, args: unknown): Promise<ToolResult> {
  return tool.logic(
    tool.inputSchema.parse(args) as never,
    context,
    {} as SdkContext,
  ) as Promise<ToolResult>;
}

/** The YAML tools of a file, by name, as the server registers them. */
async function yamlTools(content: string) {
  config.toolsYamlPath = yamlFile(content);
  const processor = new ToolProcessor();
  await processor.initialize();
  return Object.fromEntries(
    processor.getToolConfigurations().map((tool) => [tool.name, tool]),
  );
}

/**
 * Signs a profile on and exchanges the code. Returns what the built-in
 * resource-server strategy puts in the auth context for its access token.
 */
async function signOn(profile: string): Promise<AuthInfo> {
  const signedOn = await grants.signOn({
    profile: Buffer.from(profile),
    password: Buffer.from(FAKE_PASSWORD),
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    address: ADDRESS,
  });
  if (!signedOn.ok) {
    throw new Error(`sign-on was refused: ${signedOn.reason}`);
  }
  const tokens = await grants.exchangeCode({
    code: Buffer.from(signedOn.code),
    codeVerifier: VERIFIER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    address: ADDRESS,
  });
  if (!tokens.ok) {
    throw new Error(`the code exchange failed: ${tokens.error}`);
  }
  const identity = await grants.authenticate(
    tokens.accessToken.toString("latin1"),
  );
  if (typeof identity === "string") {
    throw new Error(`the access token was refused: ${identity}`);
  }
  return {
    token: GRANT_TOKEN_PREFIX + identity.grantId,
    clientId: identity.clientId,
    scopes: [],
    expiresAt: identity.expiresAt,
    extra: { subject: identity.profile, grantId: identity.grantId },
  };
}

/** Runs `task` as the request of a signed-on caller. */
const as = <T>(authInfo: AuthInfo, task: () => Promise<T>): Promise<T> =>
  authContext.run({ authInfo }, task);

/** The statement requests the fake received, from `mark` on. */
const statements = (mark = 0) =>
  fake.requests.slice(mark).filter(({ sql }) => typeof sql === "string");

function expectNoPoolWasTouched(): void {
  for (const [name, spy] of Object.entries(pools)) {
    expect(spy, name).not.toHaveBeenCalled();
  }
  expect(Pool).not.toHaveBeenCalled();
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ibmi-mcp-routing-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  Object.assign(config, { selectedToolsets: undefined, yamlAutoReload: false });
  config.oauth.mapepire.host = IBMI_HOST;
  process.env.DB2i_HOST = IBMI_HOST;
  // Whatever a local .env says: there is no service profile in this file.
  delete process.env.DB2i_USER;
  delete process.env.DB2i_PASS;
  pools = {
    serviceInstance: vi.spyOn(
      IBMiConnectionPool as unknown as { getInstance(): unknown },
      "getInstance",
    ),
    serviceQuery: vi.spyOn(IBMiConnectionPool, "executeQuery"),
    servicePaginated: vi.spyOn(
      IBMiConnectionPool,
      "executeQueryWithPagination",
    ),
    sourceInstance: vi.spyOn(SourceManager, "getInstance"),
    registerSource: vi.spyOn(SourceManager.prototype, "registerSource"),
    authenticatedInstance: vi.spyOn(AuthenticatedPoolManager, "getInstance"),
  } as unknown as typeof pools;
});

afterEach(() => {
  setGrantQueryExecutor(undefined);
  vi.restoreAllMocks();
  Pool.mockClear();
  ToolProcessor.clearWatchers();
  Object.assign(config, original);
  config.oauth.mapepire.host = originalHost;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("built-in OAuth mode", () => {
  beforeEach(async () => {
    Object.assign(config, { mcpAuthMode: "oauth", oauthIssuerUrl: undefined });
    expect(config.oauth.builtin).toBe(true);

    fake = await startFakeMapepire({
      accounts: { TESTUSER: FAKE_PASSWORD, OTHERUSR: FAKE_PASSWORD },
      statements: STATEMENTS,
    });
    grants = createGrantManager({
      mapepire: createMapepireClient({
        host: "127.0.0.1",
        port: fake.port,
        trust: { kind: "pin", pem: Buffer.from(fake.certPem) },
      }),
    });
    // Typed as the contract, so the module is checked against it.
    const router: QueryRouterApi = {
      executeQuery,
      executeQueryWithPagination,
      setGrantQueryExecutor,
    };
    router.setGrantQueryExecutor(grants);
  });

  afterEach(async () => {
    await grants.shutdown();
    await fake.stop();
  });

  describe("a signed-on caller", () => {
    it.each(BUILTIN_TOOLS)(
      "%s runs its statements on the caller's own connection",
      async (_name, tool, args, expected) => {
        const caller = await signOn("TESTUSER");
        const mark = fake.requests.length;

        const result = await as(caller, () => call(tool, args));

        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
        expect(statements(mark)).toEqual(
          expected.map((fragment) =>
            expect.objectContaining({
              profile: "TESTUSER",
              sql: expect.stringContaining(fragment),
            }),
          ),
        );
        // One sign-on, one connection, and no pool beside it.
        expect(fake.connects).toHaveLength(1);
        expectNoPoolWasTouched();
      },
    );

    it("gives the tools the same results a pool would", async () => {
      const caller = await signOn("TESTUSER");

      // One page of the size the tool asks for: limit + 1, to see whether
      // more rows exist.
      const mark = fake.requests.length;
      const page = await as(caller, () =>
        call(listSchemasTool, { limit: 150 }),
      );
      expect(statements(mark)).toEqual([
        expect.objectContaining({ rows: 151 }),
      ]);
      expect(page).toMatchObject({ rowCount: 150, hasMore: true });
      expect(page.data).toEqual(rows(150));

      // Fetched page by page until the result is complete.
      const paginated = fake.requests.length;
      const columns = await as(caller, () =>
        call(getTableColumnsTool, { schema_name: "Q", table_name: "T" }),
      );
      expect(columns.data).toEqual(rows(11));
      expect(
        fake.requests.slice(paginated).map(({ type, rows }) => [type, rows]),
      ).toEqual([
        ["prepare_sql_execute", 5],
        ["sqlmore", 5],
        ["sqlmore", 5],
      ]);

      // The tool's own fetch size.
      const generated = fake.requests.length;
      const ddl = await as(caller, () =>
        call(generateSqlTool, {
          object_name: "QCUSTCDT",
          object_library: "QIWS",
          object_type: "TABLE",
        }),
      );
      expect(ddl.sql).toBe("CREATE TABLE QIWS.QCUSTCDT (CUSNUM INT)");
      expect(statements(generated)).toEqual([
        expect.objectContaining({ rows: 500 }),
      ]);

      // Stopped at IBMI_PAGINATION_MAX_ROWS, and said so.
      const capped = await as(caller, () =>
        call(executeSqlTool, { sql: "SELECT ID FROM QIWS.TWENTYROWS" }),
      );
      expect(capped).toMatchObject({ rowCount: 12, truncated: true });
      expect(capped.data).toEqual(rows(12));
      expectNoPoolWasTouched();
    });

    it("runs a YAML tool on the caller's own connection, whatever its source says", async () => {
      const tools = await yamlTools(YAML_SOURCE + YAML_TOOLS);
      const caller = await signOn("TESTUSER");
      const mark = fake.requests.length;

      const one = await as(caller, () =>
        tools.customer_by_number!.logic({ number: 938472 }, context),
      );
      const all = await as(caller, () => tools.twenty_rows!.logic({}, context));
      const some = await as(caller, () => tools.three_rows!.logic({}, context));

      expect(one).toMatchObject({ success: true, data: [{ CUSNUM: 938472 }] });
      // fetchAllRows pages to the cap, and rowsToFetch is the one page's
      // size, as on a pool.
      expect(all).toMatchObject({ success: true, data: rows(12) });
      expect(some).toMatchObject({ success: true, data: rows(3) });
      expect(statements(mark)).toEqual([
        expect.objectContaining({
          profile: "TESTUSER",
          sql: `${CUSTOMER_QUERY} WHERE CUSNUM = ?`,
          parameters: [938472],
        }),
        expect.objectContaining({
          profile: "TESTUSER",
          sql: "SELECT ID FROM QIWS.TWENTYROWS",
          rows: 5,
        }),
        expect.objectContaining({
          profile: "TESTUSER",
          sql: "SELECT ID FROM QIWS.TWENTYROWS",
          rows: 3,
        }),
      ]);
      expect(fake.connects).toHaveLength(1);
      // Loading the file registered no source and built no pool manager.
      expectNoPoolWasTouched();
    });

    it("keeps two profiles on two connections", async () => {
      const first = await signOn("TESTUSER");
      const second = await signOn("OTHERUSR");
      const mark = fake.requests.length;

      await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          index % 2 === 0
            ? as(first, () =>
                executeQuery(`SELECT 'first' FROM QIWS.TABLE${index}`),
              )
            : as(second, () =>
                call(executeSqlTool, {
                  sql: `SELECT 'second' FROM QIWS.TABLE${index}`,
                }),
              ),
        ),
      );

      // One statement for each of the first caller's three calls; two
      // (the statement type, then the statement) for each of the second's.
      const seen = statements(mark).map(({ profile, sql, parameters }) => [
        profile,
        `${String(sql)} ${JSON.stringify(parameters ?? [])}`,
      ]);
      expect(seen.filter(([, text]) => text!.includes("'first'"))).toEqual(
        Array(3).fill(["TESTUSER", expect.any(String)]),
      );
      expect(seen.filter(([, text]) => !text!.includes("'first'"))).toEqual(
        Array(6).fill(["OTHERUSR", expect.stringContaining("'second'")]),
      );
      expect(fake.connects.map(({ profile }) => profile)).toEqual([
        "TESTUSER",
        "OTHERUSR",
      ]);
      expect(new Set(fake.connects.map(({ job }) => job)).size).toBe(2);
      expect(fake.openSockets).toBe(2);
      expectNoPoolWasTouched();
    });

    it("refuses a write before anything is sent", async () => {
      const caller = await signOn("TESTUSER");
      const mark = fake.requests.length;
      const readOnly = { readOnly: true };
      const write = "DELETE FROM QIWS.QCUSTCDT";

      await expect(
        as(caller, () =>
          executeQuery(write, [], context, { securityConfig: readOnly }),
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      await expect(
        as(caller, () =>
          executeQueryWithPagination(write, [], context, {
            securityConfig: readOnly,
          }),
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      // A YAML tool whose statement is given at run time.
      await expect(
        as(caller, () =>
          SQLToolFactory.executeStatementWithParameters(
            "run_statement",
            "ibmi-system",
            ":statement",
            { statement: write },
            [{ name: "statement", type: "string" }],
            context,
            readOnly,
          ),
        ),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      const refused = await as(caller, () =>
        call(executeSqlTool, { sql: write }),
      );
      expect(refused.success).toBe(false);

      expect(fake.requests.slice(mark)).toEqual([]);

      // The same statement runs when the tool allows writes.
      await as(caller, () =>
        executeQuery(write, [], context, {
          securityConfig: { readOnly: false },
        }),
      );
      expect(statements(mark)).toEqual([
        expect.objectContaining({ profile: "TESTUSER", sql: write }),
      ]);
    });
  });

  describe("a call without a grant", () => {
    const SQL = "SELECT 1 FROM SYSIBM.SYSDUMMY1";

    it("throws, in and out of a request, and falls back to nothing", async () => {
      // No request at all, as when tool logic is called outside a handler.
      await expect(executeQuery(SQL)).rejects.toMatchObject(UNAUTHORIZED);
      await expect(executeQueryWithPagination(SQL)).rejects.toMatchObject(
        UNAUTHORIZED,
      );

      // A request whose identity names no grant, even one that carries what
      // the other modes route by.
      const stranger: AuthInfo = {
        token: "not-a-grant",
        clientId: CLIENT_ID,
        scopes: [],
        ibmiToken: "an-ibmi-token",
      };
      for (const options of [{}, { source: "ibmi-system" }]) {
        await expect(
          as(stranger, () => executeQuery(SQL, [], context, options)),
        ).rejects.toMatchObject(UNAUTHORIZED);
        await expect(
          as(stranger, () =>
            executeQueryWithPagination(SQL, [], context, options),
          ),
        ).rejects.toMatchObject(UNAUTHORIZED);
      }

      // A grant that does not exist (ended, or made up).
      const ended: AuthInfo = {
        ...stranger,
        extra: { subject: "TESTUSER", grantId: "bm8tc3VjaC1ncmFudA" },
      };
      await expect(as(ended, () => executeQuery(SQL))).rejects.toMatchObject(
        UNAUTHORIZED,
      );

      expect(fake.upgrades).toBe(0);
      expectNoPoolWasTouched();
    });

    it("does not ask the grant manager about a request that names no grant", async () => {
      const executor = {
        executeQuery: vi.fn(),
        executeQueryWithPagination: vi.fn(),
      };
      setGrantQueryExecutor(executor);
      const identity = { token: "t", clientId: CLIENT_ID, scopes: [] };

      for (const extra of [undefined, {}, { grantId: "" }, { grantId: 7 }]) {
        const caller: AuthInfo = { ...identity, extra };
        await expect(as(caller, () => executeQuery(SQL))).rejects.toMatchObject(
          UNAUTHORIZED,
        );
        await expect(
          as(caller, () => executeQueryWithPagination(SQL)),
        ).rejects.toMatchObject(UNAUTHORIZED);
      }
      await expect(executeQuery(SQL)).rejects.toMatchObject(UNAUTHORIZED);

      expect(executor.executeQuery).not.toHaveBeenCalled();
      expect(executor.executeQueryWithPagination).not.toHaveBeenCalled();
    });

    it("fails every built-in tool and every YAML tool without opening a connection", async () => {
      const tools = await yamlTools(YAML_SOURCE + YAML_TOOLS);

      for (const [name, tool, args] of BUILTIN_TOOLS) {
        const result = await call(tool, args);
        expect(result.success, name).toBe(false);
        expect(result.error?.code, name).toBe(
          String(JsonRpcErrorCode.Unauthorized),
        );
      }
      await expect(
        tools.customer_by_number!.logic({ number: 1 }, context),
      ).rejects.toMatchObject(UNAUTHORIZED);
      await expect(tools.twenty_rows!.logic({}, context)).rejects.toMatchObject(
        UNAUTHORIZED,
      );

      expect(fake.upgrades).toBe(0);
      expectNoPoolWasTouched();
    });

    it("throws for a signed-on caller when no grant manager is registered", async () => {
      const caller = await signOn("TESTUSER");
      const mark = fake.requests.length;
      setGrantQueryExecutor(undefined);

      await expect(as(caller, () => executeQuery(SQL))).rejects.toMatchObject(
        UNAUTHORIZED,
      );

      expect(fake.requests.slice(mark)).toEqual([]);
      expectNoPoolWasTouched();
    });
  });

  describe("YAML sources", () => {
    it("ignores a source's user and password: their variables need not be set and nothing is read into them", async () => {
      process.env.QUERY_ROUTING_TEST_VALUE = "from-the-environment";
      process.env.DB2i_PORT = "8076";
      try {
        const path = yamlFile(`
sources:${source("with-variables", "${DB2i_HOST}")}
  with-other-variables:
    host: IBMI.Example.Test
    user: \${QUERY_ROUTING_TEST_VALUE}
    password: at-\${DB2i_HOST}-\${DB2i_PORT}
`);

        const { config: parsed } = await ConfigParser.parseYamlFile(path);

        expect(parsed.sources).toEqual({
          "with-variables": {
            host: IBMI_HOST,
            user: "${DB2i_USER}",
            password: "${DB2i_PASS}",
          },
          "with-other-variables": {
            host: "IBMI.Example.Test",
            user: "${QUERY_ROUTING_TEST_VALUE}",
            password: `at-${IBMI_HOST}-8076`,
          },
        });
        expect(await startupError(path)).toBe("");
      } finally {
        delete process.env.QUERY_ROUTING_TEST_VALUE;
      }
      expectNoPoolWasTouched();
    });

    it("substitutes DB2i_HOST and DB2i_PORT in tool text, and nothing else of the server's environment", async () => {
      process.env.QUERY_ROUTING_TEST_VALUE = "from-the-environment";
      process.env.DB2i_PORT = "8076";
      const WITHHELD =
        "environment variable(s) a tool file cannot read with the built-in OAuth sign-on, where only ${DB2i_HOST} and ${DB2i_PORT} are substituted:";
      const tool = (description: string, statement: string) => `${YAML_SOURCE}
tools:
  with_variables:
    source: ibmi-system
    description: "${description}"
    statement: "${statement}"
`;
      try {
        const allowed = yamlFile(
          tool(
            "Runs on ${DB2i_HOST}:${DB2i_PORT}",
            "SELECT '${DB2i_HOST}' AS HOST FROM SYSIBM.SYSDUMMY1",
          ),
        );
        const { config: parsed } = await ConfigParser.parseYamlFile(allowed);
        expect(parsed.tools?.with_variables).toMatchObject({
          description: `Runs on ${IBMI_HOST}:8076`,
          statement: `SELECT '${IBMI_HOST}' AS HOST FROM SYSIBM.SYSDUMMY1`,
        });
        expect(await startupError(allowed)).toBe("");

        // A variable that is set: its value would reach every user who
        // calls the tool.
        const inStatement = yamlFile(
          tool(
            "Reads the environment",
            "SELECT '${QUERY_ROUTING_TEST_VALUE}' AS V FROM SYSIBM.SYSDUMMY1",
          ),
        );
        const inDescription = yamlFile(
          tool(
            "${QUERY_ROUTING_TEST_VALUE}, and ${QUERY_ROUTING_UNSET_TEXT}",
            "SELECT 1 FROM SYSIBM.SYSDUMMY1",
          ),
        );
        const inHost = yamlFile(
          YAML_SOURCE.replace("${DB2i_HOST}", "${QUERY_ROUTING_TEST_VALUE}"),
        );
        // A `user` that is not a source's.
        const inMetadata = yamlFile(`${YAML_SOURCE}
metadata:
  owner:
    user: \${QUERY_ROUTING_TEST_VALUE}
`);

        const errors = {
          inStatement: await startupError(inStatement),
          inDescription: await startupError(inDescription),
          inHost: await startupError(inHost),
          inMetadata: await startupError(inMetadata),
        };
        expect(errors.inStatement).toContain(
          `${inStatement}: ${WITHHELD} QUERY_ROUTING_TEST_VALUE`,
        );
        expect(errors.inDescription).toContain(
          `${inDescription}: ${WITHHELD} QUERY_ROUTING_TEST_VALUE, QUERY_ROUTING_UNSET_TEXT`,
        );
        expect(errors.inHost).toContain(
          `${inHost}: ${WITHHELD} QUERY_ROUTING_TEST_VALUE`,
        );
        expect(errors.inMetadata).toContain(
          `${inMetadata}: ${WITHHELD} QUERY_ROUTING_TEST_VALUE`,
        );
        expect(Object.values(errors).join()).not.toContain(
          "from-the-environment",
        );

        // A caller that never connects is told nothing, and is given the
        // text as written, not the value.
        const unchecked = await ConfigParser.parseYamlFile(
          inStatement,
          undefined,
          true,
        );
        expect(unchecked.config.tools?.with_variables?.statement).toBe(
          "SELECT '${QUERY_ROUTING_TEST_VALUE}' AS V FROM SYSIBM.SYSDUMMY1",
        );
      } finally {
        delete process.env.QUERY_ROUTING_TEST_VALUE;
      }
      expectNoPoolWasTouched();
    });

    it("still refuses to start when DB2i_PORT is named and not set", async () => {
      const saved = process.env.DB2i_PORT;
      delete process.env.DB2i_PORT;
      try {
        const path = yamlFile(`${YAML_SOURCE}
tools:
  on_the_port:
    source: ibmi-system
    description: "Port \${DB2i_PORT}"
    statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"
`);

        expect(await startupError(path)).toContain(
          `${path}: environment variable(s) not set: DB2i_PORT`,
        );
      } finally {
        if (saved !== undefined) process.env.DB2i_PORT = saved;
      }
    });

    it("refuses to start when a source names another host, naming the file and the source", async () => {
      const path =
        yamlFile(`${YAML_SOURCE}${source("other-system", "other.example.test")}${YAML_TOOLS}
  elsewhere:
    source: other-system
    description: "Runs somewhere else"
    statement: "SELECT 1 FROM SYSIBM.SYSDUMMY1"
`);

      const error = await startupError(path);

      expect(error).toContain(`Invalid tool configuration in ${path}`);
      expect(error).toContain(
        "Source 'other-system' names host 'other.example.test'",
      );
      expect(error).toContain(`DB2i_HOST (${IBMI_HOST})`);
      expect(error).not.toContain("'ibmi-system'");
      expectNoPoolWasTouched();
    });

    it("refuses to start when a source sets its own jdbc-options, naming the file and the source", async () => {
      const path = yamlFile(`${YAML_SOURCE}    jdbc-options:
      libraries: [MYLIB]
`);

      const error = await startupError(path);

      expect(error).toContain(`Invalid tool configuration in ${path}`);
      expect(error).toContain("Source 'ibmi-system' sets jdbc-options");
      expectNoPoolWasTouched();
    });

    it("does not apply the source rules to a caller that never connects", async () => {
      const path = yamlFile(
        YAML_SOURCE.replace("${DB2i_HOST}", "other.example.test"),
      );

      await expect(
        ConfigParser.parseYamlFile(path, undefined, true),
      ).resolves.toMatchObject({ stats: { sourceCount: 1 } });
    });
  });
});

describe("every other mode", () => {
  const SQL = "SELECT 1 FROM SYSIBM.SYSDUMMY1";
  const PAGE = { success: true, data: [{ "00001": 1 }] };
  const security = { readOnly: true };
  const withToken: AuthInfo = {
    token: "t",
    clientId: "c",
    scopes: [],
    ibmiToken: "an-ibmi-token",
    extra: { grantId: "a-grant-id" },
  };
  /** A grant manager that must never be asked. */
  const executor = {
    executeQuery: vi.fn(),
    executeQueryWithPagination: vi.fn(),
  };

  function stubManager() {
    const stub = {
      executeQuery: vi.fn().mockResolvedValue(PAGE),
      executeQueryWithPagination: vi.fn().mockResolvedValue(PAGE),
    };
    return { stub, manager: stub as unknown as SourceManager };
  }

  beforeEach(() => {
    Object.assign(config, { mcpAuthMode: "none" });
    expect(config.oauth.builtin).toBe(false);
    setGrantQueryExecutor(executor);
    pools.serviceQuery.mockResolvedValue(PAGE);
    pools.servicePaginated.mockResolvedValue(PAGE);
  });

  afterEach(() => {
    expect(executor.executeQuery).not.toHaveBeenCalled();
    expect(executor.executeQueryWithPagination).not.toHaveBeenCalled();
    expect(Pool).not.toHaveBeenCalled();
  });

  it("runs a statement without a source on the service pool, with the arguments it was given", async () => {
    // Also for a caller with an IBM i token: the built-in tools have always
    // run on the service pool.
    expect(await as(withToken, () => executeQuery(SQL, [1], context))).toBe(
      PAGE,
    );
    await executeQuery(SQL, [1], context, { rowsToFetch: 51 });
    expect(
      await as(withToken, () => executeQueryWithPagination(SQL, [], context)),
    ).toBe(PAGE);
    await executeQueryWithPagination(SQL, [], context, { rowsToFetch: 500 });

    expect(pools.serviceQuery.mock.calls).toEqual([
      [SQL, [1], context],
      [SQL, [1], context, 51],
    ]);
    expect(pools.servicePaginated.mock.calls).toEqual([
      [SQL, [], context],
      [SQL, [], context, 500],
    ]);
    expect(pools.authenticatedInstance).not.toHaveBeenCalled();
    expect(pools.sourceInstance).not.toHaveBeenCalled();
  });

  it("runs a statement with a source on that source's pool", async () => {
    const { stub, manager } = stubManager();
    const singleton = stubManager();
    pools.sourceInstance.mockReturnValue(singleton.manager);

    await executeQuery(SQL, [], context, {
      source: "one",
      sourceManager: manager,
    });
    await executeQuery(SQL, [], context, {
      source: "one",
      securityConfig: security,
      sourceManager: manager,
    });
    await executeQuery(SQL, [], context, {
      source: "one",
      rowsToFetch: 7,
      sourceManager: manager,
    });
    await executeQueryWithPagination(SQL, [], context, {
      source: "one",
      securityConfig: security,
      rowsToFetch: 7,
      sourceManager: manager,
    });
    // Without a manager of the caller's own: the server's.
    await executeQuery(SQL, [], context, { source: "two" });

    expect(stub.executeQuery.mock.calls).toEqual([
      ["one", SQL, [], context],
      ["one", SQL, [], context, security],
      ["one", SQL, [], context, undefined, 7],
    ]);
    expect(stub.executeQueryWithPagination.mock.calls).toEqual([
      ["one", SQL, [], context, 7, security],
    ]);
    expect(singleton.stub.executeQuery.mock.calls).toEqual([
      ["two", SQL, [], context],
    ]);
    expect(pools.serviceQuery).not.toHaveBeenCalled();
    expect(pools.authenticatedInstance).not.toHaveBeenCalled();
  });

  it("runs a statement with a source on the caller's authenticated pool when the request carries an IBM i token", async () => {
    const { stub, manager } = stubManager();
    const authenticated = stubManager();
    pools.authenticatedInstance.mockReturnValue(
      authenticated.stub as unknown as AuthenticatedPoolManager,
    );
    const route = {
      source: "one",
      securityConfig: security,
      rowsToFetch: 7,
      sourceManager: manager,
    };

    await as(withToken, () => executeQuery(SQL, [], context, route));
    await as(withToken, () =>
      executeQueryWithPagination(SQL, [], context, route),
    );

    expect(authenticated.stub.executeQuery.mock.calls).toEqual([
      ["an-ibmi-token", SQL, [], context, security, 7],
    ]);
    expect(authenticated.stub.executeQueryWithPagination.mock.calls).toEqual([
      ["an-ibmi-token", SQL, [], context, 7, security],
    ]);
    expect(stub.executeQuery).not.toHaveBeenCalled();
    expect(stub.executeQueryWithPagination).not.toHaveBeenCalled();
  });

  it("refuses a statement the tool's security settings forbid before any pool is asked", async () => {
    const { stub, manager } = stubManager();
    const route = { securityConfig: security, sourceManager: manager };
    const write = "DELETE FROM QIWS.QCUSTCDT";

    for (const options of [route, { ...route, source: "one" }]) {
      await expect(
        executeQuery(write, [], context, options),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      await expect(
        executeQueryWithPagination(write, [], context, options),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    }

    expect(stub.executeQuery).not.toHaveBeenCalled();
    expect(stub.executeQueryWithPagination).not.toHaveBeenCalled();
    expect(pools.serviceQuery).not.toHaveBeenCalled();
    expect(pools.servicePaginated).not.toHaveBeenCalled();
  });

  it("registers the YAML sources and applies none of the built-in source rules", async () => {
    process.env.DB2i_USER = "TESTUSER";
    process.env.DB2i_PASS = FAKE_PASSWORD;
    const path = yamlFile(`${YAML_SOURCE}    jdbc-options:
      libraries: [MYLIB]
${source("other-system", "other.example.test")}`);
    pools.registerSource.mockResolvedValue(undefined);

    expect(await startupError(path)).toBe("");

    expect(
      pools.registerSource.mock.calls.map(([name, registered]) => [
        name,
        registered,
      ]),
    ).toEqual([
      [
        "ibmi-system",
        {
          host: IBMI_HOST,
          user: "TESTUSER",
          password: FAKE_PASSWORD,
          "jdbc-options": { libraries: ["MYLIB"] },
        },
      ],
      [
        "other-system",
        {
          host: "other.example.test",
          user: "TESTUSER",
          password: FAKE_PASSWORD,
        },
      ],
    ]);

    // And a variable a source's credentials name must be set.
    delete process.env.DB2i_PASS;
    expect(await startupError(path)).toContain(
      "environment variable(s) not set: DB2i_PASS",
    );
  });
});
