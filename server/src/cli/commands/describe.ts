/**
 * @fileoverview `ibmi describe <objects>` command — generate DDL for SQL objects.
 * Accepts a comma-delimited list of LIBRARY.OBJECT references and returns
 * the CREATE statement for each using the QSYS2.GENERATE_SQL service.
 * @module cli/commands/describe
 */

import { Command } from "commander";
import { withConnection } from "../utils/command-helpers.js";
import type { SdkContext } from "../../mcp-server/tools/utils/types.js";

/** Supported object types (mirrors generateSql.tool.ts OBJECT_TYPES). */
const VALID_TYPES = [
  "ALIAS",
  "CONSTRAINT",
  "FUNCTION",
  "INDEX",
  "MASK",
  "PERMISSION",
  "PROCEDURE",
  "SCHEMA",
  "SEQUENCE",
  "TABLE",
  "TRIGGER",
  "TYPE",
  "VARIABLE",
  "VIEW",
  "XSR",
] as const;

/**
 * Parse a qualified object reference into library and name.
 * "SAMPLE.EMPLOYEE" → { library: "SAMPLE", name: "EMPLOYEE" }
 * "EMPLOYEE"        → { name: "EMPLOYEE" } (library defaults at tool level)
 */
function parseObjectRef(ref: string): { library?: string; name: string } {
  const parts = ref.trim().split(".");
  if (parts.length === 2) {
    return { library: parts[0]!.toUpperCase(), name: parts[1]!.toUpperCase() };
  }
  return { name: parts[0]!.toUpperCase() };
}

export function registerDescribeCommand(program: Command): void {
  program
    .command("describe <objects>")
    .description(
      "Generate DDL for one or more SQL objects (comma-separated LIBRARY.OBJECT)",
    )
    .option(
      "--type <type>",
      `Object type: ${VALID_TYPES.join(", ")}`,
      "TABLE",
    )
    .action(async (objects: string, opts, cmd: Command) => {
      const objectType = (opts["type"] as string).toUpperCase();
      if (!VALID_TYPES.includes(objectType as (typeof VALID_TYPES)[number])) {
        process.stderr.write(
          `Error: Invalid --type "${opts["type"]}". Valid types: ${VALID_TYPES.join(", ")}\n`,
        );
        process.exitCode = 1;
        return;
      }

      const refs = objects
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (refs.length === 0) {
        process.stderr.write("Error: No objects specified.\n");
        process.exitCode = 1;
        return;
      }

      await withConnection(
        cmd,
        "describe_sql_object",
        async (_resolved, ctx) => {
          const { generateSqlTool } = await import(
            "../../ibmi-mcp-server/tools/generateSql.tool.js"
          );
          const logicFn = generateSqlTool.logic;

          const data: Record<string, unknown>[] = [];

          for (const ref of refs) {
            const parsed = parseObjectRef(ref);
            const result = await logicFn(
              {
                object_name: parsed.name,
                object_library: parsed.library ?? "QSYS2",
                object_type: objectType as (typeof VALID_TYPES)[number],
              },
              ctx,
              {} as SdkContext,
            );

            const qualifiedName = parsed.library
              ? `${parsed.library}.${parsed.name}`
              : parsed.name;

            if (result.success && result.sql) {
              data.push({
                OBJECT: qualifiedName,
                TYPE: objectType,
                DDL: result.sql,
              });
            } else {
              data.push({
                OBJECT: qualifiedName,
                TYPE: objectType,
                DDL: `ERROR: ${result.error?.message ?? "DDL generation failed"}`,
              });
            }
          }

          return {
            data,
            meta: { rowCount: data.length },
          };
        },
      );
    });
}
