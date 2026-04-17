/**
 * @fileoverview `ibmi schemas` command — list available schemas/libraries.
 * @module cli/commands/schemas
 */

import { Command } from "commander";
import { withConnection } from "../utils/command-helpers.js";
import { ExitCode } from "../utils/exit-codes.js";
import type { SdkContext } from "../../public/tools.js";

export function registerSchemasCommand(program: Command): void {
  program
    .command("schemas")
    .description("List schemas/libraries on the target system")
    .option("--filter <pattern>", "Filter by schema name (SQL LIKE pattern, e.g. 'MY%')")
    .option("--system-schemas", "Include system schemas (Q* and SYS*)", false)
    .option("--limit <n>", "Maximum rows to return", "50")
    .option("--offset <n>", "Rows to skip for pagination", "0")
    .action(async (opts, cmd: Command) => {
      const limit = parseInt(opts["limit"] as string, 10);
      const offset = parseInt(opts["offset"] as string, 10);
      if (isNaN(limit) || limit < 0) {
        process.stderr.write(`Error: Invalid --limit value: "${opts["limit"]}". Must be a positive integer.\n`);
        process.exitCode = ExitCode.USAGE;
        return;
      }
      if (isNaN(offset) || offset < 0) {
        process.stderr.write(`Error: Invalid --offset value: "${opts["offset"]}". Must be a non-negative integer.\n`);
        process.exitCode = ExitCode.USAGE;
        return;
      }

      await withConnection(cmd, "list_schemas", async (_resolved, ctx) => {
        const { listSchemasLogic } = await import("../../public/tools.js");

        const result = await listSchemasLogic(
          {
            filter: opts["filter"] as string | undefined,
            include_system: opts["systemSchemas"] as boolean,
            limit,
            offset,
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
