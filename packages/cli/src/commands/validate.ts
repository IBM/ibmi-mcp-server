/**
 * @fileoverview `ibmi validate "<sql>"` command — validate SQL syntax and object references.
 * @module cli/commands/validate
 */

import { Command } from "commander";
import { withConnection } from "../utils/command-helpers.js";
import type { SdkContext } from "@ibm/ibmi-mcp-server/tools";

export function registerValidateCommand(program: Command): void {
  program
    .command("validate <sql>")
    .description("Validate SQL syntax and verify referenced objects exist")
    .action(async (sql: string, _opts, cmd: Command) => {
      await withConnection(cmd, "validate_query", async (_resolved, ctx) => {
        const { validateQueryLogic } = await import("@ibm/ibmi-mcp-server/tools");

        const result = await validateQueryLogic(
          { sql_statement: sql },
          ctx,
          {} as SdkContext,
        );

        if (!result.success) {
          throw new Error(result.error?.message ?? "Failed to validate query");
        }

        // Build a summary view for CLI output
        const summary: Record<string, unknown>[] = [];

        // Parse results summary
        if (result.data && result.data.length > 0) {
          const stmtTypes = [
            ...new Set(
              result.data
                .map((r) => r.SQL_STATEMENT_TYPE as string | undefined)
                .filter(Boolean),
            ),
          ];
          summary.push({
            CHECK: "Syntax",
            STATUS: "PASS",
            DETAILS: stmtTypes.length > 0
              ? `Statement type: ${stmtTypes.join(", ")}`
              : "Parsed successfully",
          });
        } else {
          summary.push({
            CHECK: "Syntax",
            STATUS: "FAIL",
            DETAILS: "Statement could not be parsed (syntax error)",
          });
        }

        // Object validation summary
        const ov = result.objectValidation;
        if (ov) {
          summary.push({
            CHECK: "Tables",
            STATUS: ov.tables.invalid.length === 0 ? "PASS" : "FAIL",
            DETAILS:
              ov.tables.invalid.length === 0
                ? `${ov.tables.valid.length} table(s) verified`
                : `Not found: ${ov.tables.invalid.join(", ")}`,
          });

          if (ov.columns.valid.length > 0 || ov.columns.invalid.length > 0) {
            summary.push({
              CHECK: "Columns",
              STATUS: ov.columns.invalid.length === 0 ? "PASS" : "WARN",
              DETAILS:
                ov.columns.invalid.length === 0
                  ? `${ov.columns.valid.length} column(s) verified`
                  : `Not verified: ${ov.columns.invalid.join(", ")}`,
            });
          }

          if (ov.routines.valid.length > 0 || ov.routines.invalid.length > 0) {
            summary.push({
              CHECK: "Routines",
              STATUS: ov.routines.invalid.length === 0 ? "PASS" : "WARN",
              DETAILS:
                ov.routines.invalid.length === 0
                  ? `${ov.routines.valid.length} routine(s) verified`
                  : `Not verified: ${ov.routines.invalid.join(", ")}`,
            });
          }
        }

        return {
          data: summary,
          meta: { rowCount: summary.length },
        };
      });
    });
}
