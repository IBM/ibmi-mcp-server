/**
 * @fileoverview `ibmi schemas` command — list available schemas/libraries.
 * @module cli/commands/schemas
 */

import { Command } from "commander";
import { withConnection } from "../utils/command-helpers.js";
import type { SdkContext } from "../../mcp-server/tools/utils/types.js";

export function registerSchemasCommand(program: Command): void {
  program
    .command("schemas")
    .description("List schemas/libraries on the target system")
    .option("--filter <pattern>", "Filter by schema name (SQL LIKE pattern, e.g. 'MY%')")
    .option("--system-schemas", "Include system schemas (Q* and SYS*)", false)
    .option("--limit <n>", "Maximum rows to return", "50")
    .option("--offset <n>", "Rows to skip for pagination", "0")
    .action(async (opts, cmd: Command) => {
      await withConnection(cmd, "list_schemas", async (_resolved, ctx) => {
        const { listSchemasLogic } = await import(
          "../../ibmi-mcp-server/tools/listSchemas.tool.js"
        );

        const result = await listSchemasLogic(
          {
            filter: opts["filter"] as string | undefined,
            include_system: opts["systemSchemas"] as boolean,
            limit: parseInt(opts["limit"] as string, 10),
            offset: parseInt(opts["offset"] as string, 10),
          },
          ctx,
          {} as SdkContext,
        );

        if (!result.success) {
          throw new Error(result.error?.message ?? "Failed to list schemas");
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
