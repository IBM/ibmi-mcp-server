/**
 * @fileoverview `ibmi sql "<sql>"` command — execute SQL queries.
 * Supports inline SQL, --file, and stdin piping.
 * @module cli/commands/sql
 */

import { readFileSync } from "fs";
import { Command } from "commander";
import { withConnection, getFormat } from "../utils/command-helpers.js";
import { renderMessage } from "../formatters/output.js";
import { ExitCode } from "../utils/exit-codes.js";
import type { SdkContext } from "../../mcp-server/tools/utils/types.js";

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
      // Resolve SQL source: argument > --file > stdin
      let sql = statement;

      if (!sql && opts["file"]) {
        try {
          sql = readFileSync(opts["file"] as string, "utf-8").trim();
        } catch (err) {
          process.stderr.write(
            `Error reading file: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exitCode = ExitCode.USAGE;
          return;
        }
      }

      if (!sql) {
        sql = readStdin() ?? undefined;
      }

      if (!sql) {
        process.stderr.write(
          "Error: No SQL provided. Pass as argument, use --file, or pipe via stdin.\n",
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

        // Apply maxRows limit if not already in the query
        let execSql = sql!;
        const maxRows = opts["limit"]
          ? parseInt(opts["limit"] as string, 10)
          : resolved.config.maxRows;

        if (
          maxRows &&
          !execSql.toUpperCase().includes("FETCH FIRST") &&
          !execSql.toUpperCase().includes("FETCH NEXT")
        ) {
          execSql = `${execSql.replace(/;\s*$/, "")} FETCH FIRST ${maxRows} ROWS ONLY`;
        }

        // Configure execute_sql tool security before importing
        const { configureExecuteSqlTool } = await import(
          "../../ibmi-mcp-server/tools/executeSql.tool.js"
        );
        configureExecuteSqlTool({
          enabled: true,
          security: { readOnly },
        });

        const { executeSqlTool } = await import(
          "../../ibmi-mcp-server/tools/executeSql.tool.js"
        );
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
