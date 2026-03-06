/**
 * @fileoverview `ibmi system` commands for managing IBM i system configurations.
 * Provides list, show, add, remove, default, and test subcommands.
 * @module cli/commands/system
 */

import { Command } from "commander";
import * as readline from "readline";
import {
  loadConfig,
  upsertSystem,
  removeSystem,
  setDefaultSystem,
  getUserConfigPath,
  getProjectConfigPath,
  type SystemConfig,
  type OutputFormat,
} from "../config/index.js";
import {
  detectFormat,
  renderOutput,
  renderError,
  renderMessage,
} from "../formatters/output.js";
import { ExitCode, classifyError } from "../utils/exit-codes.js";
import { connectSystem } from "../utils/connection.js";

/**
 * Get the effective output format from parent command options.
 */
function getFormat(cmd: Command): OutputFormat {
  const opts = cmd.optsWithGlobals();
  return detectFormat(opts["format"] as OutputFormat | undefined, opts["raw"] as boolean | undefined);
}

/** Result of a connection test. */
interface ConnectionTestResult {
  NAME: string;
  HOST: string;
  PORT: number;
  USER: string;
  STATUS: string;
  ERROR?: string;
  [key: string]: unknown;
}

/**
 * Test connectivity to an IBM i system by establishing and closing a connection.
 */
async function testSystemConnection(
  name: string,
  sys: SystemConfig,
): Promise<ConnectionTestResult> {
  const base = { NAME: name, HOST: sys.host, PORT: sys.port, USER: sys.user };

  let cleanup: (() => Promise<void>) | undefined;
  try {
    const resolved = {
      name,
      config: sys,
      source: "flag" as const,
    };
    cleanup = await connectSystem(resolved);

    return { ...base, STATUS: "connected" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, STATUS: "error", ERROR: msg };
  } finally {
    if (cleanup) await cleanup();
  }
}

/**
 * Register all `ibmi system` subcommands.
 */
export function registerSystemCommand(program: Command): void {
  const system = program
    .command("system")
    .description("Manage IBM i system connections");

  // ── ibmi system list ──
  system
    .command("list")
    .description("List all configured systems")
    .action((_opts, cmd: Command) => {
      const format = getFormat(cmd);
      try {
        const config = loadConfig();
        const systems = Object.entries(config.systems);

        if (systems.length === 0) {
          renderMessage(
            "No systems configured. Run: ibmi system add <name>",
            format,
          );
          return;
        }

        const data = systems.map(([name, sys]) => ({
          NAME: name,
          HOST: sys.host,
          USER: sys.user,
          PORT: sys.port,
          READ_ONLY: sys.readOnly ? "yes" : "no",
          DEFAULT: name === config.default ? "✓" : "",
        }));

        renderOutput(data, format, { rowCount: data.length });
      } catch (err) {
        renderError(err instanceof Error ? err : new Error(String(err)), format);
        process.exitCode = ExitCode.GENERAL;
      }
    });

  // ── ibmi system show <name> ──
  system
    .command("show <name>")
    .description("Show configuration for a system")
    .action((name: string, _opts, cmd: Command) => {
      const format = getFormat(cmd);
      try {
        const config = loadConfig();
        const sys = config.systems[name];
        if (!sys) {
          throw new Error(
            `System "${name}" not found. Run: ibmi system list`,
          );
        }

        const data = [
          { PROPERTY: "host", VALUE: sys.host },
          { PROPERTY: "port", VALUE: String(sys.port) },
          { PROPERTY: "user", VALUE: sys.user },
          { PROPERTY: "password", VALUE: sys.password ? "****" : "(not set)" },
          { PROPERTY: "defaultSchema", VALUE: sys.defaultSchema ?? "(none)" },
          { PROPERTY: "readOnly", VALUE: String(sys.readOnly) },
          { PROPERTY: "confirm", VALUE: String(sys.confirm) },
          { PROPERTY: "timeout", VALUE: `${sys.timeout}s` },
          { PROPERTY: "maxRows", VALUE: String(sys.maxRows) },
          { PROPERTY: "description", VALUE: sys.description ?? "(none)" },
          {
            PROPERTY: "default",
            VALUE: name === config.default ? "yes" : "no",
          },
        ];

        renderOutput(data, format, { rowCount: data.length });
      } catch (err) {
        renderError(err instanceof Error ? err : new Error(String(err)), format);
        process.exitCode = ExitCode.GENERAL;
      }
    });

  // ── ibmi system add <name> ──
  system
    .command("add <name>")
    .description("Add a new system configuration")
    .option("--host <host>", "IBM i hostname")
    .option("--port <port>", "Mapepire port", "8076")
    .option("--user <user>", "User profile")
    .option("--password <password>", "Password (or use env var reference: ${MY_PASS})")
    .option("--description <desc>", "Description")
    .option("--read-only", "Block mutation queries", false)
    .option("--default-schema <schema>", "Default schema/library")
    .action(async (name: string, opts, cmd: Command) => {
      const format = getFormat(cmd);
      try {
        let host = opts["host"] as string | undefined;
        let user = opts["user"] as string | undefined;

        // Interactive prompts for required fields
        if (!host || !user) {
          if (!process.stdin.isTTY) {
            throw new Error(
              "Missing required options --host and --user. In non-interactive mode, all options must be provided.",
            );
          }

          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stderr,
          });

          const ask = (question: string): Promise<string> =>
            new Promise((resolve) => rl.question(question, resolve));

          if (!host) host = await ask("Host: ");
          if (!user) user = await ask("User: ");

          rl.close();
        }

        const system: SystemConfig = {
          host,
          port: parseInt(opts["port"] as string, 10),
          user,
          password: opts["password"] as string | undefined,
          description: opts["description"] as string | undefined,
          defaultSchema: opts["defaultSchema"] as string | undefined,
          readOnly: opts["readOnly"] as boolean,
          confirm: false,
          timeout: 60,
          maxRows: 5000,
          ignoreUnauthorized: true,
        };

        upsertSystem(name, system);
        renderMessage(
          `System "${name}" added. Config saved to ${getUserConfigPath()}`,
          format,
        );
      } catch (err) {
        renderError(err instanceof Error ? err : new Error(String(err)), format);
        process.exitCode = ExitCode.GENERAL;
      }
    });

  // ── ibmi system remove <name> ──
  system
    .command("remove <name>")
    .description("Remove a system configuration")
    .action((name: string, _opts, cmd: Command) => {
      const format = getFormat(cmd);
      try {
        const removed = removeSystem(name);
        if (removed) {
          renderMessage(`System "${name}" removed.`, format);
        } else {
          throw new Error(`System "${name}" not found.`);
        }
      } catch (err) {
        renderError(err instanceof Error ? err : new Error(String(err)), format);
        process.exitCode = ExitCode.GENERAL;
      }
    });

  // ── ibmi system default <name> ──
  system
    .command("default <name>")
    .description("Set the default system")
    .action((name: string, _opts, cmd: Command) => {
      const format = getFormat(cmd);
      try {
        setDefaultSystem(name);
        renderMessage(`Default system set to "${name}".`, format);
      } catch (err) {
        renderError(err instanceof Error ? err : new Error(String(err)), format);
        process.exitCode = ExitCode.GENERAL;
      }
    });

  // ── ibmi system test [name] ──
  system
    .command("test [name]")
    .description("Test connectivity to a system")
    .option("--all", "Test all configured systems")
    .action(async (name: string | undefined, opts, cmd: Command) => {
      const format = getFormat(cmd);
      try {
        const config = loadConfig();

        if (opts["all"]) {
          const results = [];
          for (const [sysName, sys] of Object.entries(config.systems)) {
            const result = await testSystemConnection(sysName, sys);
            results.push(result);
          }
          renderOutput(results, format, { rowCount: results.length });
          return;
        }

        // Resolve which system to test
        const targetName =
          name ??
          cmd.optsWithGlobals()["system"] ??
          config.default;

        if (!targetName) {
          throw new Error(
            "No system specified. Pass a name or set a default.",
          );
        }

        const sys = config.systems[targetName];
        if (!sys) {
          throw new Error(`System "${targetName}" not found.`);
        }

        const result = await testSystemConnection(targetName, sys);
        renderOutput(
          [
            { PROPERTY: "system", VALUE: result.NAME },
            { PROPERTY: "host", VALUE: `${result.HOST}:${result.PORT}` },
            { PROPERTY: "user", VALUE: result.USER },
            { PROPERTY: "status", VALUE: result.STATUS },
            ...(result.ERROR ? [{ PROPERTY: "error", VALUE: result.ERROR }] : []),
          ],
          format,
          { rowCount: 1 },
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const classified = classifyError(error);
        renderError(error, format, undefined, classified.errorCode);
        process.exitCode = classified.exitCode;
      }
    });

  // ── ibmi system config-path ──
  system
    .command("config-path")
    .description("Show config file paths")
    .action((_opts, cmd: Command) => {
      const format = getFormat(cmd);
      renderOutput(
        [
          { SCOPE: "user", PATH: getUserConfigPath() },
          { SCOPE: "project", PATH: getProjectConfigPath() },
        ],
        format,
        { rowCount: 2 },
      );
    });
}
