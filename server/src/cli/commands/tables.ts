/**
 * @fileoverview `ibmi tables <schema>` command — list tables in a schema.
 * @module cli/commands/tables
 */

import { Command } from "commander";
import { withConnection } from "../utils/command-helpers.js";
import type { SdkContext } from "../../mcp-server/tools/utils/types.js";

export function registerTablesCommand(program: Command): void {
  program
    .command("tables <schema>")
    .description("List tables, views, and physical files in a schema")
    .option("--filter <pattern>", "Filter by table name (SQL LIKE pattern, e.g. 'CUST%')")
    .option("--limit <n>", "Maximum rows to return", "50")
    .option("--offset <n>", "Rows to skip for pagination", "0")
    .action(async (schema: string, opts, cmd: Command) => {
      await withConnection(cmd, "list_tables_in_schema", async (_resolved, ctx) => {
        const { listTablesLogic } = await import(
          "../../ibmi-mcp-server/tools/listTablesInSchema.tool.js"
        );

        const result = await listTablesLogic(
          {
            schema_name: schema,
            table_filter: (opts["filter"] as string | undefined) ?? "*ALL",
            limit: parseInt(opts["limit"] as string, 10),
            offset: parseInt(opts["offset"] as string, 10),
          },
          ctx,
          {} as SdkContext,
        );

        if (!result.success) {
          throw new Error(result.error?.message ?? "Failed to list tables");
        }

        return {
          data: (result.data ?? []) as Record<string, unknown>[],
          meta: {
            rowCount: result.rowCount ?? 0,
            hasMore: result.hasMore,
          },
        };
      });
    });
}
