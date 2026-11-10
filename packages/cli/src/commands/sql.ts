/**
 * @fileoverview `ibmi sql "<sql>"` command — execute SQL queries.
 * Supports inline SQL, --file, stdin piping, and multi-system parallel execution.
 * @module cli/commands/sql
 */

import { readFileSync } from "fs";
import { Command } from "commander";
import {
  withConnection,
  withOutput,
  getFormat,
  createCliContext,
} from "../utils/command-helpers.js";
import {
  renderError,
  renderMessage,
  renderMultiSystemOutput,
  renderMultiSystemNdjson,
} from "../formatters/output.js";
import {
  ExitCode,
  ErrorCode,
  ToolError,
  UsageError,
  classifyError,
} from "../utils/exit-codes.js";
import type { SdkContext } from "@ibm/ibmi-mcp-server/tools";

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
 * Statement text that makes appending FETCH FIRST unsafe: a comment (the
 * clause could land inside it), an existing row-limiting clause, or a clause
 * that has to follow FETCH FIRST (FOR READ ONLY, WITH UR, ...). This is a
 * plain text match, so it can also hit inside a string literal; the row limit
 * is then enforced on the fetched rows by {@link limitRows} instead.
 */
const NO_FETCH_APPEND =
  /--|\/\*|\b(FETCH\s+(FIRST|NEXT)|LIMIT|OFFSET|FOR\s+(READ|FETCH)\s+ONLY|FOR\s+UPDATE|OPTIMIZE\s+FOR|WITH\s+(UR|CS|RS|RR|NC)|SKIP\s+LOCKED\s+DATA|USE\s+CURRENTLY\s+COMMITTED|WAIT\s+FOR\s+OUTCOME)\b/i;

/**
 * Append FETCH FIRST N ROWS ONLY to a query when that is safe (see
 * {@link NO_FETCH_APPEND}); otherwise return the statement unchanged.
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
    !NO_FETCH_APPEND.test(sql)
  ) {
    return `${sql.replace(/;\s*$/, "")} FETCH FIRST ${maxRows} ROWS ONLY`;
  }
  return sql;
}

/**
 * Enforce the row limit on fetched rows, for statements whose text
 * {@link applyRowLimit} left alone. `limited` is true when rows were dropped.
 */
export function limitRows(
  rows: Record<string, unknown>[],
  maxRows: number | undefined,
): { rows: Record<string, unknown>[]; limited: boolean } {
  if (!maxRows || rows.length <= maxRows) return { rows, limited: false };
  return { rows: rows.slice(0, maxRows), limited: true };
}

/** Ask once before executing on systems that set `confirm: true`. */
async function confirmExecution(systemNames: string[]): Promise<void> {
  const { promptLine } = await import("../config/credentials.js");
  const answer = await promptLine(
    `Execute on [${systemNames.join(", ")}]? (y/N) `,
  );
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
    .option("--read-only", "Enforce read-only mode (default: true)", true)
    .option("--no-read-only", "Allow mutation queries")
    .option("--dry-run", "Print SQL without executing", false)
    .option(
      "--yes",
      "Skip the prompt for systems that require confirmation",
      false,
    )
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

      // Dry run: print SQL and exit
      if (opts["dryRun"]) {
        const format = getFormat(cmd);
        await withOutput(cmd, async () => renderMessage(sql, format));
        return;
      }

      // Validate --limit before connecting so a bad value is a usage error
      let limit: number | undefined;
      if (opts["limit"]) {
        limit = parseInt(opts["limit"] as string, 10);
        if (isNaN(limit) || limit <= 0) {
          renderError(
            new Error(
              `Invalid --limit value: "${opts["limit"]}". Must be a positive integer.`,
            ),
            getFormat(cmd),
            undefined,
            ErrorCode.USAGE_ERROR,
          );
          process.exitCode = ExitCode.USAGE;
          return;
        }
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

        await handleMultiSystemSql(sql, opts, cmd, systemFlag, limit);
        return;
      }

      // Existing single-system path (unchanged)
      await withConnection(cmd, "execute_sql", async (resolved, ctx) => {
        // Configure read-only mode based on CLI flag and system config
        const readOnly =
          (opts["readOnly"] as boolean) || resolved.config.readOnly;

        // Confirm execution if system requires it
        if (resolved.config.confirm && !opts["yes"] && process.stdin.isTTY) {
          await confirmExecution([resolved.name]);
        }

        // Apply maxRows limit
        const maxRows = limit ?? resolved.config.maxRows;
        const execSql = applyRowLimit(sql, maxRows);

        // Configure execute_sql tool security before importing
        const { configureExecuteSqlTool, executeSqlTool } = await import(
          "@ibm/ibmi-mcp-server/tools"
        );
        configureExecuteSqlTool({
          enabled: true,
          security: { readOnly },
        });
        const logicFn = executeSqlTool.logic;

        const result = await logicFn(
          { sql: execSql },
          ctx,
          {} as SdkContext,
        );

        if (!result.success) {
          throw new ToolError(result.error, "SQL execution failed");
        }

        const { rows, limited } = limitRows(
          (result.data ?? []) as Record<string, unknown>[],
          maxRows,
        );

        // execute_sql paginates at the service layer and flags `truncated`
        // when it hits IBMI_PAGINATION_MAX_ROWS. Surface that in the footer
        // so `ibmi sql` users see the same truncation hint `ibmi tool` shows.
        const truncated = result.truncated === true;

        return {
          data: rows,
          meta: {
            rowCount: rows.length,
            hasMore: limited || truncated,
            truncationHint: limited
              ? `(limited to ${maxRows} rows — raise --limit for more)`
              : truncated
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
 */
async function handleMultiSystemSql(
  sql: string,
  opts: Record<string, unknown>,
  cmd: Command,
  systemFlag: string,
  limit: number | undefined,
): Promise<void> {
  const format = getFormat(cmd);
  const isStream = cmd.optsWithGlobals()["stream"] === true;

  await withOutput(cmd, async () => {
    try {
      const { resolveSystems } = await import("../config/resolver.js");
      const { executeMultiSystem } = await import(
        "../utils/multi-connection.js"
      );

      const systems = resolveSystems(systemFlag);

      // Enforce read-only: true if CLI flag is set OR any target system requires it
      const readOnly =
        (opts["readOnly"] as boolean) ||
        systems.some((s) => s.config.readOnly);

      if (readOnly) {
        const { SqlSecurityValidator } = await import(
          "@ibm/ibmi-mcp-server/services"
        );
        const ctx = createCliContext("multi_sql_security");
        SqlSecurityValidator.validateQuery(
          sql,
          { readOnly: true, maxQueryLength: 10000 },
          ctx,
        );
      }

      // One confirmation covers every target that requires it. Never run
      // unconfirmed: without a terminal to ask on, --yes is required.
      const confirmSystems = systems
        .filter((s) => s.config.confirm)
        .map((s) => s.name);
      if (confirmSystems.length > 0 && !opts["yes"]) {
        if (!process.stdin.isTTY) {
          throw new UsageError(
            `System(s) [${confirmSystems.join(", ")}] require confirmation. Pass --yes to run without a prompt.`,
          );
        }
        await confirmExecution(confirmSystems);
      }

      // Respect the most restrictive system's row limit when none is explicit
      let maxRows = limit;
      if (maxRows === undefined) {
        maxRows = Math.min(
          ...systems.map((s) => s.config.maxRows ?? Infinity),
        );
        if (!isFinite(maxRows)) maxRows = undefined;
      }

      const execSql = applyRowLimit(sql, maxRows);

      const results = await executeMultiSystem(
        systems,
        async (sourceName, mgr, ctx) => {
          // Paginate like the single-system path; a plain executeQuery stops
          // at the driver's default page of 100 rows.
          const result = await mgr.executeQueryWithPagination(
            sourceName,
            execSql,
            [],
            ctx,
          );
          const { rows, limited } = limitRows(
            (result.data ?? []) as Record<string, unknown>[],
            maxRows,
          );
          return {
            data: rows,
            meta: { hasMore: limited || result.truncated === true },
          };
        },
      );

      if (isStream && format === "json") {
        renderMultiSystemNdjson(results);
      } else {
        renderMultiSystemOutput(results, format);
      }

      if (results.some((r) => r.error)) {
        process.exitCode = ExitCode.GENERAL;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const classified = classifyError(error);
      renderError(error, format, undefined, classified.errorCode);
      process.exitCode = classified.exitCode;
    }
  });
}
