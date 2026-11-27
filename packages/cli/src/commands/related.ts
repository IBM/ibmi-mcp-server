/**
 * @fileoverview `ibmi related <library> <object>` command — find dependent objects.
 * @module cli/commands/related
 */

import { Command } from "commander";
import { withConnection } from "../utils/command-helpers.js";
import { ToolError } from "../utils/exit-codes.js";
import type { SdkContext } from "@ibm/ibmi-mcp-server/tools";

export function registerRelatedCommand(program: Command): void {
  program
    .command("related <library> <object>")
    .description("Find objects that depend on a database file")
    .option(
      "--type <type>",
      "Filter by object type (e.g. INDEX, VIEW, TRIGGER, FOREIGN KEY)",
    )
    .action(async (library: string, object: string, opts, cmd: Command) => {
      await withConnection(
        cmd,
        "get_related_objects",
        async (_resolved, ctx) => {
          const { getRelatedObjectsLogic } =
            await import("@ibm/ibmi-mcp-server/tools");

          const result = await getRelatedObjectsLogic(
            {
              library_name: library,
              file_name: object,
              // The server compares against upper-case type names (as `describe --type` does)
              object_type_filter: (
                opts["type"] as string | undefined
              )?.toUpperCase() as Parameters<
                typeof getRelatedObjectsLogic
              >[0]["object_type_filter"],
            },
            ctx,
            {} as SdkContext,
          );

          if (!result.success) {
            throw new ToolError(result.error, "Failed to get related objects");
          }

          return {
            data: (result.data ?? []) as Record<string, unknown>[],
            meta: {
              rowCount: result.rowCount ?? 0,
            },
          };
        },
      );
    });
}
