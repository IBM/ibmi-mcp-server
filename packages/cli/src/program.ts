/**
 * @fileoverview Commander program definition for the IBM i CLI (`ibmi`).
 * Kept separate from the executable entry point so it can be imported
 * (e.g. by tests) without running the CLI.
 * @module cli/program
 */

// First: it has to run before any module of the server is loaded.
import "./serverAuthMode.js";
import { Command, Option } from "commander";
import { registerConfigCommand } from "./commands/config.js";
import { registerSystemCommand } from "./commands/system.js";
import { registerSchemasCommand } from "./commands/schemas.js";
import { registerTablesCommand } from "./commands/tables.js";
import { registerColumnsCommand } from "./commands/columns.js";
import { registerRelatedCommand } from "./commands/related.js";
import { registerValidateCommand } from "./commands/validate.js";
import { registerDescribeCommand } from "./commands/describe.js";
import { registerSqlCommand } from "./commands/sql.js";
import { registerToolCommand } from "./commands/tool.js";
import {
  registerToolsCommand,
  registerToolsetsCommand,
} from "./commands/tools-list.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerSessionHostCommand } from "./commands/session-host.js";
import { getVersion } from "./version.js";

/**
 * Create and configure the CLI program.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("ibmi")
    .description(
      "IBM i command-line interface — query, explore, and manage IBM i systems",
    )
    .version(getVersion(), "-v, --version")
    .option(
      "--system <name>",
      "Target system name (overrides IBMI_SYSTEM and config default)",
    )
    .addOption(
      new Option("--format <type>", "Output format").choices([
        "table",
        "json",
        "csv",
        "markdown",
      ]),
    )
    .option("--raw", "Output as JSON (shorthand for --format json)")
    .option("--no-color", "Disable colored output")
    .option(
      "--tools <path>",
      "Path to YAML tool file(s) or directory (comma-separated)",
    )
    .option("--stream", "Stream results as NDJSON (one JSON object per line)")
    .option("--watch <seconds>", "Re-run command at interval (seconds)")
    .option(
      "--fresh",
      "Connect for this command only; do not use or open an SSH session",
    )
    .option("--output <path>", "Write output to file instead of stdout");

  // Register command groups
  registerConfigCommand(program);
  registerSystemCommand(program);
  registerSchemasCommand(program);
  registerTablesCommand(program);
  registerColumnsCommand(program);
  registerRelatedCommand(program);
  registerValidateCommand(program);
  registerDescribeCommand(program);
  registerSqlCommand(program);
  registerToolCommand(program);
  registerToolsCommand(program);
  registerToolsetsCommand(program);
  registerCompletionCommand(program);
  registerSessionHostCommand(program);

  // Add a helpful message for when no command is given
  program.action(() => {
    program.outputHelp();
  });

  return program;
}
