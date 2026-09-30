/**
 * @fileoverview `ibmi sql "<sql>"` command — execute SQL queries.
 * Supports inline SQL, --file, stdin piping, and multi-system parallel execution.
 * @module cli/commands/sql
 */

import { readFileSync } from "fs";
import { Command } from "commander";
import { withConnection, getFormat } from "../utils/command-helpers.js";
import { renderMessage, renderMultiSystemOutput, renderMultiSystemNdjson } from "../formatters/output.js";
import { ExitCode, classifyError } from "../utils/exit-codes.js";
import {
  accessFromFlags,
  assertNotLoweredByEnv,
  assertWithinSystemCeilings,
} from "../utils/access-mode.js";
import type { ResolvedSystem } from "../config/types.js";
import type { ExecuteSqlAccess, SdkContext } from "@ibm/ibmi-mcp-server/tools";

/**
 * Read SQL from stdin (piped input).
 * Returns null if stdin is a TTY (interactive).
 */
function readStdin(): string | null {
  if (process.stdin.isTTY) return null;

  try {
    return readFileSync(0, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Resolve SQL from the various sources: argument, --file, or stdin.
 * Returns the SQL string or undefined if no source provided.
 */
function resolveSql(
  statement: string | undefined,
  opts: Record<string, unknown>,
): string | undefined {
  if (statement) return statement;

  if (opts["file"]) {
    try {
      return readFileSync(opts["file"] as string, "utf-8").trim();
    } catch (err) {
      process.stderr.write(
        `Error reading file: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = ExitCode.USAGE;
      return undefined;
    }
  }

  return readStdin() ?? undefined;
}

/**
 * Apply FETCH FIRST N ROWS ONLY to queries if not already present.
 * Non-query statements (CALL, INSERT, DDL, ...) do not accept a fetch clause
 * and are passed through unchanged (#173).
 */
export function applyRowLimit(
  sql: string,
  maxRows: number | undefined,
): string {
  if (
    maxRows &&
    /^\s*(SELECT|WITH|VALUES)\b/i.test(sql) &&
    !sql.toUpperCase().includes("FETCH FIRST") &&
    !sql.toUpperCase().includes("FETCH NEXT")
  ) {
    return `${sql.replace(/;\s*$/, "")} FETCH FIRST ${maxRows} ROWS ONLY`;
  }
  return sql;
}

/**
 * Ask for confirmation on a system configured with `confirm: true`
 * (interactive terminals only).
 *
 * @throws Error when the user declines
 */
async function confirmExecution(system: ResolvedSystem): Promise<void> {
  if (!system.config.confirm || !process.stdin.isTTY) return;
  const { promptPassword } = await import("../config/credentials.js");
  const answer = await promptPassword(`Execute on [${system.name}]? (y/N) `);
  if (answer.toLowerCase() !== "y") {
    throw new Error("Execution cancelled by user");
  }
}

export function registerSqlCommand(program: Command): void {
  program
    .command("sql [statement]")
    .description("Execute a SQL query against the target system")
    .option("--file <path>", "Read SQL from a file")
    .option("--limit <n>", "Maximum rows to return")
    .option(
      "--access <mode>",
      "Guardrail mode: read (default, queries only), read-call (also CALL), or write",
    )
    .option("--read-only", "[deprecated] Same as --access read")
    .option("--no-read-only", "[deprecated] Same as --access write")
    .option("--dry-run", "Print SQL without executing", false)
    .action(async (statement: string | undefined, opts, cmd: Command) => {
      const sql = resolveSql(statement, opts);
      if (!sql) {
        if (!process.exitCode) {
          process.stderr.write(
            "Error: No SQL provided. Pass as argument, use --file, or pipe via stdin.\n",
          );
          process.exitCode = ExitCode.USAGE;
        }
        return;
      }

      let access: ExecuteSqlAccess;
      try {
        access = accessFromFlags(opts);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = ExitCode.USAGE;
        return;
      }

      // Dry run: print SQL and exit
      if (opts["dryRun"]) {
        const format = getFormat(cmd);
        renderMessage(sql, format);
        return;
      }

      // Multi-system detection
      const systemFlag = cmd.optsWithGlobals()["system"] as string | undefined;
      if (systemFlag && systemFlag.includes(",")) {
        // Reject --watch + multi-system for v1
        if (cmd.optsWithGlobals()["watch"]) {
          process.stderr.write(
            "Error: --watch is not supported with multiple systems.\n",
          );
          process.exitCode = ExitCode.USAGE;
          return;
        }

        await handleMultiSystemSql(sql, access, opts, cmd, systemFlag);
        return;
      }

      await withConnection(cmd, "execute_sql", async (resolved, ctx) => {
        assertWithinSystemCeilings(access, [resolved]);

        // Configure execute_sql before its first query: the singleton pool
        // takes its JDBC access from the mode when it initializes
        const {
          configureExecuteSqlTool,
          executeSqlTool,
          stripStatementTerminator,
          EXECUTE_SQL_ACCESS_ENV,
        } = await import("@ibm/ibmi-mcp-server/tools");
        const effective = configureExecuteSqlTool({
          enabled: true,
          security: {
            access,
            forbiddenKeywords: resolved.config.forbiddenKeywords,
          },
        });
        assertNotLoweredByEnv(access, effective, EXECUTE_SQL_ACCESS_ENV);

        await confirmExecution(resolved);

        // Apply maxRows limit; the guardrails validate the limited text
        let maxRows = resolved.config.maxRows;
        if (opts["limit"]) {
          maxRows = parseInt(opts["limit"] as string, 10);
          if (isNaN(maxRows) || maxRows <= 0) {
            throw new Error(`Invalid --limit value: "${opts["limit"]}". Must be a positive integer.`);
          }
        }
        const execSql = applyRowLimit(stripStatementTerminator(sql), maxRows);

        // Guardrail rejections throw (classified as security violations)
        const result = await executeSqlTool.logic(
          { sql: execSql },
          ctx,
          {} as SdkContext,
        );

        if (!result.success) {
          throw new Error(result.error?.message ?? "SQL execution failed");
        }

        // execute_sql paginates at the service layer and flags `truncated`
        // when it hits IBMI_PAGINATION_MAX_ROWS. Surface that in the footer
        // so `ibmi sql` users see the same truncation hint `ibmi tool` shows.
        const truncated = result.truncated === true;

        return {
          data: (result.data ?? []) as Record<string, unknown>[],
          meta: {
            rowCount: result.rowCount ?? 0,
            hasMore: truncated,
            truncationHint: truncated
              ? "(result capped — raise IBMI_PAGINATION_MAX_ROWS or narrow the query)"
              : undefined,
          },
        };
      });
    });
}

/**
 * Execute SQL against multiple systems in parallel via SourceManager.
 * Creates a temporary SourceManager — each system gets its own pool.
 * Each system runs the same execute_sql guardrails as the single-system
 * path, with PARSE_STATEMENT (when needed) on that system's own pool.
 */
async function handleMultiSystemSql(
  sql: string,
  access: ExecuteSqlAccess,
  opts: Record<string, unknown>,
  cmd: Command,
  systemFlag: string,
): Promise<void> {
  const format = getFormat(cmd);
  const isStream = cmd.optsWithGlobals()["stream"] === true;

  try {
    const { resolveSystems } = await import("../config/resolver.js");
    const { executeMultiSystem } = await import("../utils/multi-connection.js");

    const systems = resolveSystems(systemFlag);
    assertWithinSystemCeilings(access, systems);

    const {
      enforceExecuteSqlGuardrails,
      stripStatementTerminator,
      getExecuteSqlAccessCeiling,
      minAccess,
      jdbcAccessFor,
      EXECUTE_SQL_ACCESS_ENV,
    } = await import("@ibm/ibmi-mcp-server/tools");
    const ceiling = getExecuteSqlAccessCeiling();
    assertNotLoweredByEnv(
      access,
      ceiling ? minAccess(ceiling, access) : access,
      EXECUTE_SQL_ACCESS_ENV,
    );

    // Respect the most restrictive system's row limit when none is explicit
    let maxRows: number | undefined;
    if (opts["limit"]) {
      maxRows = parseInt(opts["limit"] as string, 10);
      if (isNaN(maxRows) || maxRows <= 0) {
        process.stderr.write(
          `Error: Invalid --limit value: "${opts["limit"]}". Must be a positive integer.\n`,
        );
        process.exitCode = ExitCode.USAGE;
        return;
      }
    } else {
      maxRows = Math.min(
        ...systems.map((s) => s.config.maxRows ?? Infinity),
      );
      if (!isFinite(maxRows)) maxRows = undefined;
    }

    // The guardrails validate exactly the text that runs
    const execSql = applyRowLimit(stripStatementTerminator(sql), maxRows);

    // Prompts are interactive, so ask before the parallel fan-out
    for (const sys of systems) await confirmExecution(sys);

    const byName = new Map(systems.map((s) => [s.name, s]));
    const results = await executeMultiSystem(
      systems,
      async (sourceName, mgr, ctx) => {
        await enforceExecuteSqlGuardrails(
          execSql,
          {
            access,
            parseStatement: (query, params, rowsToFetch) =>
              mgr.executeQuery(
                sourceName,
                query,
                params,
                ctx,
                undefined,
                rowsToFetch,
              ),
            forbiddenKeywords: byName.get(sourceName)?.config.forbiddenKeywords,
          },
          ctx,
        );
        const result = await mgr.executeQuery(
          sourceName,
          execSql,
          [],
          ctx,
        );
        const data = (result.data ?? []) as Record<string, unknown>[];
        return { data, meta: { rowCount: data.length } };
      },
      { access: jdbcAccessFor(access) },
    );

    if (isStream && format === "json") {
      renderMultiSystemNdjson(results);
    } else {
      renderMultiSystemOutput(results, format);
    }

    // Per-system failures stay in the output; the exit code reports the first
    const failed = results.find((r) => r.exitCode !== undefined);
    if (failed) process.exitCode = failed.exitCode;
  } catch (err) {
    const { renderError } = await import("../formatters/output.js");
    const error = err instanceof Error ? err : new Error(String(err));
    const classified = classifyError(error);
    renderError(error, format, undefined, classified.errorCode);
    process.exitCode = classified.exitCode;
  }
}
