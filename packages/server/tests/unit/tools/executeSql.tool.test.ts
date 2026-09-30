/**
 * Unit tests for executeSql.tool.ts: guardrail wiring, mode configuration
 * (ceiling, deprecated readOnly), and the mode-dependent description and
 * annotations.
 *
 * @module tests/unit/tools/executeSql.tool.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@ibm/mapepire-js";

vi.mock("../../../src/ibmi-mcp-server/services/connectionPool.js", () => ({
  IBMiConnectionPool: {
    executeQuery: vi.fn(),
    executeQueryWithPagination: vi.fn(),
  },
}));

import { config } from "../../../src/config/index.js";
import { McpError } from "../../../src/types-global/errors.js";
import { createRequestContext } from "../../../src/utils/internal/requestContext.js";
import { IBMiConnectionPool } from "../../../src/ibmi-mcp-server/services/connectionPool.js";
import {
  configureExecuteSqlTool,
  executeSqlTool,
} from "../../../src/ibmi-mcp-server/tools/executeSql.tool.js";
import { createHandler } from "../../../src/mcp-server/tools/utils/tool-factory.js";
import type { SdkContext } from "../../../src/mcp-server/tools/utils/types.js";

const context = createRequestContext({ operation: "ExecuteSqlToolTest" });
const sdk = {} as SdkContext;
const executeQuery = vi.mocked(IBMiConnectionPool.executeQuery);
const executeWithPagination = vi.mocked(
  IBMiConnectionPool.executeQueryWithPagination,
);

const parseRows = (rows: Record<string, unknown>[]) =>
  ({
    success: true,
    is_done: true,
    data: rows,
  }) as unknown as QueryResult<unknown>;
const queryRow = (nameType: string, schema: string, name: string) => ({
  NAME_TYPE: nameType,
  SCHEMA: schema,
  NAME: name,
  USAGE_TYPE: "QUERY",
  SQL_STATEMENT_TYPE: "QUERY",
});

const run = (sql: string) => executeSqlTool.logic({ sql }, context, sdk);

describe("execute_sql tool", () => {
  const originalCeiling = config.ibmi_executeSqlAccessCeiling;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    executeWithPagination.mockResolvedValue({
      success: true,
      data: [{ A: 1 }],
      truncated: false,
    });
    configureExecuteSqlTool({ enabled: true, security: { access: "read" } });
  });

  afterEach(() => {
    config.ibmi_executeSqlAccessCeiling = originalCeiling;
    process.env = { ...originalEnv };
    configureExecuteSqlTool({
      security: { access: "read", forbiddenKeywords: undefined },
    });
  });

  describe("guardrails", () => {
    it("runs a quick-path query without PARSE_STATEMENT", async () => {
      const result = await run("SELECT * FROM QSYS2.SYSTABLES;");
      expect(result.success).toBe(true);
      expect(executeQuery).not.toHaveBeenCalled();
      expect(executeWithPagination).toHaveBeenCalledWith(
        "SELECT * FROM QSYS2.SYSTABLES",
        [],
        context,
      );
    });

    it("asks PARSE_STATEMENT on the same pool when the quick path is unsure", async () => {
      process.env.DB2i_HOST = "h";
      process.env.DB2i_USER = "u";
      process.env.DB2i_PASS = "p";
      process.env.DB2i_JDBC_OPTIONS = "naming=system";
      executeQuery.mockResolvedValue(
        parseRows([queryRow("TABLE", "QSYS2", "SYSTABLES")]),
      );

      await run("SELECT /* c */ * FROM QSYS2.SYSTABLES");

      expect(executeQuery).toHaveBeenCalledTimes(1);
      const [query, params, , rowsToFetch] = executeQuery.mock.calls[0]!;
      expect(query).toContain("QSYS2.PARSE_STATEMENT");
      expect(params).toEqual([
        "SELECT /* c */ * FROM QSYS2.SYSTABLES",
        "*SYS",
        "*PERIOD",
      ]);
      expect(rowsToFetch).toBe(10_000);
      expect(executeWithPagination).toHaveBeenCalled();
    });

    it("throws a guardrail rejection before executing (logic throws)", async () => {
      executeQuery.mockResolvedValue(
        parseRows([queryRow("FUNCTION", "QSYS2", "QCMDEXC")]),
      );
      await expect(
        run("SELECT QSYS2.QCMDEXC('DLTLIB X') FROM SYSIBM.SYSDUMMY1"),
      ).rejects.toBeInstanceOf(McpError);
      expect(executeWithPagination).not.toHaveBeenCalled();
    });

    it("surfaces a rejection as an isError result with rule and lowest mode", async () => {
      const handler = createHandler(
        executeSqlTool.name,
        executeSqlTool.logic,
        executeSqlTool.responseFormatter,
      );
      const result = await handler({ sql: "DELETE FROM QTEMP.T" }, {});
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        details: {
          access: "read",
          rule: "statement-type",
          offending: "DELETE",
          lowestMode: "write",
        },
      });
      expect(executeQuery).not.toHaveBeenCalled();
    });

    it("read-call allows CALL; write skips PARSE_STATEMENT entirely", async () => {
      configureExecuteSqlTool({ security: { access: "read-call" } });
      await expect(
        run("CALL QSYS2.GENERATE_SQL('T', 'L', 'TABLE')"),
      ).resolves.toMatchObject({ success: true });

      configureExecuteSqlTool({ security: { access: "write" } });
      await expect(run("DELETE FROM QTEMP.T")).resolves.toMatchObject({
        success: true,
      });
      expect(executeQuery).not.toHaveBeenCalled();
    });

    it("applies configured forbidden keywords in write mode", async () => {
      configureExecuteSqlTool({
        security: { access: "write", forbiddenKeywords: ["DROP"] },
      });
      await expect(run("DROP TABLE QTEMP.T")).rejects.toThrow(
        /forbidden keyword/,
      );
    });
  });

  describe("configuration", () => {
    it("returns the effective mode and maps the deprecated readOnly flag", () => {
      expect(configureExecuteSqlTool({ security: { readOnly: false } })).toBe(
        "write",
      );
      expect(configureExecuteSqlTool({ security: { readOnly: true } })).toBe(
        "read",
      );
      expect(
        configureExecuteSqlTool({
          security: { access: "read-call", readOnly: false },
        }),
      ).toBe("read-call");
    });

    it("an env ceiling lowers the requested mode", () => {
      config.ibmi_executeSqlAccessCeiling = "read-call";
      expect(configureExecuteSqlTool({ security: { access: "write" } })).toBe(
        "read-call",
      );
      expect(configureExecuteSqlTool({ security: { access: "read" } })).toBe(
        "read",
      );
    });

    it.each([
      ["read", true, false, /read-only query/],
      ["read-call", false, true, /CALL to a stored procedure/],
      ["write", false, true, /Executes any single SQL statement/],
    ] as const)(
      "%s: description and annotations follow the configured mode",
      (access, readOnlyHint, destructiveHint, description) => {
        configureExecuteSqlTool({ security: { access } });
        expect(executeSqlTool.annotations).toEqual({
          readOnlyHint,
          destructiveHint,
          openWorldHint: destructiveHint,
        });
        expect(executeSqlTool.description).toMatch(description);
      },
    );

    it("read description names the configured forbidden functions", () => {
      const original = config.ibmi_executeSqlForbiddenFunctions;
      try {
        configureExecuteSqlTool({ security: { access: "read" } });
        config.ibmi_executeSqlForbiddenFunctions = ["QCMDEXC", "HTTP*"];
        expect(executeSqlTool.description).toContain("QCMDEXC, HTTP*");
        config.ibmi_executeSqlForbiddenFunctions = [];
        expect(executeSqlTool.description).not.toContain("QCMDEXC");
      } finally {
        config.ibmi_executeSqlForbiddenFunctions = original;
      }
    });
  });
});
