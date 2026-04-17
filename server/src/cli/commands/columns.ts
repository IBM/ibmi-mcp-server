/**
 * @fileoverview `ibmi columns <schema> <table>` command — get column metadata.
 * @module cli/commands/columns
 */

import { Command } from "commander";
import { withConnection } from "../utils/command-helpers.js";
import type { SdkContext } from "../../public/tools.js";

export function registerColumnsCommand(program: Command): void {
  program
    .command("columns <schema> <table>")
    .description("Get column metadata for a table")
    .action(async (schema: string, table: string, _opts, cmd: Command) => {
      await withConnection(cmd, "get_table_columns", async (_resolved, ctx) => {
        const { getTableColumnsLogic } = await import("../../public/tools.js");

        const result = await getTableColumnsLogic(
          {
            schema_name: schema,
            table_name: table,
          },
          ctx,
          {} as SdkContext,
        );

        if (!result.success) {
          throw new Error(result.error?.message ?? "Failed to get table columns");
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
