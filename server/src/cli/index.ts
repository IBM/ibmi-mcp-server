#!/usr/bin/env node

/**
 * @fileoverview Entry point for the IBM i CLI (`ibmi`).
 * Provides a human-friendly and agent-friendly command-line interface to IBM i systems,
 * reusing the same tool infrastructure as the MCP server.
 * @module cli/index
 */

import { Command } from "commander";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { registerSystemCommand } from "./commands/system.js";
import { registerSchemasCommand } from "./commands/schemas.js";
import { registerTablesCommand } from "./commands/tables.js";
import { registerColumnsCommand } from "./commands/columns.js";
import { registerRelatedCommand } from "./commands/related.js";
import { registerValidateCommand } from "./commands/validate.js";
import { registerSqlCommand } from "./commands/sql.js";
import { registerToolCommand } from "./commands/tool.js";
import { registerToolsCommand, registerToolsetsCommand } from "./commands/tools-list.js";

/**
 * Load version from package.json.
 */
function getVersion(): string {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    // Walk up to find package.json (handles both src/ and dist/)
    let dir = currentDir;
    for (let i = 0; i < 5; i++) {
      try {
        const pkg = JSON.parse(
          readFileSync(path.join(dir, "package.json"), "utf-8"),
        );
        if (pkg.name === "@ibm/ibmi-mcp-server") {
          return pkg.version as string;
        }
      } catch {
        // Continue searching
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Fallback
  }
  return "0.0.0";
}

/**
 * Create and configure the CLI program.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("ibmi")
    .description("IBM i command-line interface — query, explore, and manage IBM i systems")
    .version(getVersion(), "-v, --version")
    .option("--system <name>", "Target system name (overrides IBMI_SYSTEM and config default)")
    .option("--format <type>", "Output format: table, json, csv, markdown", undefined)
    .option("--raw", "Output as JSON (shorthand for --format json)")
    .option("--no-color", "Disable colored output")
    .option("--tools <path>", "Path to YAML tool file(s) or directory (comma-separated)");

  // Register command groups
  registerSystemCommand(program);
  registerSchemasCommand(program);
  registerTablesCommand(program);
  registerColumnsCommand(program);
  registerRelatedCommand(program);
  registerValidateCommand(program);
  registerSqlCommand(program);
  registerToolCommand(program);
  registerToolsCommand(program);
  registerToolsetsCommand(program);

  // Add a helpful message for when no command is given
  program.action(() => {
    program.outputHelp();
  });

  return program;
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const program = createProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    // Commander handles most errors, but catch anything unexpected
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

main();
