/**
 * @fileoverview `ibmi related <library> <object>` command — find dependent objects.
 * @module cli/commands/related
 */

import { Command } from "commander";
import { withConnection } from "../utils/command-helpers.js";
import type { SdkContext } from "../../public/tools.js";

export function registerRelatedCommand(program: Command): void {
  program
    .command("related <library> <object>")
    .description("Find objects that depend on a database file")
    .option(
      "--type <type>",
      "Filter by object type (e.g. INDEX, VIEW, TRIGGER, FOREIGN KEY)",
    )
    .action(async (library: string, object: string, opts, cmd: Command) => {
      await withConnection(cmd, "get_related_objects", async (_resolved, ctx) => {
        const { getRelatedObjectsLogic } = await import("../../public/tools.js");

        const result = await getRelatedObjectsLogic(
          {
            library_name: library,
            file_name: object,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            object_type_filter: opts["type"] as any,
          },
          ctx,
          {} as SdkContext,
        );

        if (!result.success) {
          throw new Error(result.error?.message ?? "Failed to get related objects");
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
