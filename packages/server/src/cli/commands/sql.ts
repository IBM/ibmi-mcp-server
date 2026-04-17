/**
 * @fileoverview `ibmi sql "<sql>"` command — execute SQL queries.
 * Supports inline SQL, --file, stdin piping, and multi-system parallel execution.
 * @module cli/commands/sql
 */

import { readFileSync } from "fs";
import { Command } from "commander";
import { withConnection, getFormat, createCliContext } from "../utils/command-helpers.js";
import { renderMessage, renderMultiSystemOutput, renderMultiSystemNdjson } from "../formatters/output.js";
import { ExitCode } from "../utils/exit-codes.js";
import type { SdkContext } from "../../public/tools.js";

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
 * Apply FETCH FIRST N ROWS ONLY if not already present.
 */
function applyRowLimit(sql: string, maxRows: number | undefined): string {
  if (
    maxRows &&
    !sql.toUpperCase().includes("FETCH FIRST") &&
    !sql.toUpperCase().includes("FETCH NEXT")
  ) {
    return `${sql.replace(/;\s*$/, "")} FETCH FIRST ${maxRows} ROWS ONLY`;
  }
  return sql;
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

        await handleMultiSystemSql(sql, opts, cmd, systemFlag);
        return;
      }

      // Existing single-system path (unchanged)
      await withConnection(cmd, "execute_sql", async (resolved, ctx) => {
        // Configure read-only mode based on CLI flag and system config
        const readOnly =
          (opts["readOnly"] as boolean) || resolved.config.readOnly;

        // Confirm execution if system requires it
        if (resolved.config.confirm && process.stdin.isTTY) {
          const { promptPassword } = await import(
            "../config/credentials.js"
          );
          const answer = await promptPassword(
            `Execute on [${resolved.name}]? (y/N) `,
          );
          if (answer.toLowerCase() !== "y") {
            throw new Error("Execution cancelled by user");
          }
        }

        // Apply maxRows limit
        let execSql = sql;
        let maxRows = resolved.config.maxRows;
        if (opts["limit"]) {
          maxRows = parseInt(opts["limit"] as string, 10);
          if (isNaN(maxRows) || maxRows <= 0) {
            throw new Error(`Invalid --limit value: "${opts["limit"]}". Must be a positive integer.`);
          }
        }
        execSql = applyRowLimit(execSql, maxRows);

        // Configure execute_sql tool security before importing
        const { configureExecuteSqlTool, executeSqlTool } = await import(
          "../../public/tools.js"
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
          throw new Error(result.error?.message ?? "SQL execution failed");
        }

        return {
          data: (result.data ?? []) as Record<string, unknown>[],
          meta: {
            rowCount: result.rowCount ?? 0,
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
): Promise<void> {
  const format = getFormat(cmd);
  const isStream = cmd.optsWithGlobals()["stream"] === true;

  try {
    const { resolveSystems } = await import("../config/resolver.js");
    const { executeMultiSystem } = await import("../utils/multi-connection.js");

    const systems = resolveSystems(systemFlag);

    // Enforce read-only: true if CLI flag is set OR any target system requires it
    const readOnly =
      (opts["readOnly"] as boolean) ||
      systems.some((s) => s.config.readOnly);

    if (readOnly) {
      const { SqlSecurityValidator } = await import(
        "../../public/services.js"
      );
      const ctx = createCliContext("multi_sql_security");
      SqlSecurityValidator.validateQuery(
        sql,
        { readOnly: true, maxQueryLength: 10000 },
        ctx,
      );
    }

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

    const execSql = applyRowLimit(sql, maxRows);

    const results = await executeMultiSystem(
      systems,
      async (sourceName, mgr, ctx) => {
        const result = await mgr.executeQuery(
          sourceName,
          execSql,
          [],
          ctx,
        );
        const data = (result.data ?? []) as Record<string, unknown>[];
        return { data, meta: { rowCount: data.length } };
      },
    );

    if (isStream && format === "json") {
      renderMultiSystemNdjson(results);
    } else {
      renderMultiSystemOutput(results, format);
    }
  } catch (err) {
    const { renderError } = await import("../formatters/output.js");
    const error = err instanceof Error ? err : new Error(String(err));
    renderError(error, format);
    process.exitCode = ExitCode.GENERAL;
  }
}
