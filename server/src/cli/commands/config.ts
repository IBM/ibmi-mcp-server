/**
 * @fileoverview `ibmi config` commands for inspecting CLI configuration.
 * Shows merged configuration with per-setting origin tracking.
 * @module cli/commands/config
 */

import { Command } from "commander";
import {
  loadConfig,
  loadConfigLayers,
  getUserConfigPath,
  type ConfigLayer,
} from "../config/index.js";
import { renderOutput, renderError } from "../formatters/output.js";
import { ExitCode } from "../utils/exit-codes.js";
import { getFormat } from "../utils/command-helpers.js";

/**
 * Determine which config layer a top-level key (`default` or `format`) came from.
 * Project layer takes precedence if it defines the key.
 */
function findOrigin(layers: ConfigLayer[], key: "default" | "format"): string {
  // Check project first (higher precedence)
  for (const layer of [...layers].reverse()) {
    if (layer.config && layer.config[key] !== undefined) {
      return layer.scope;
    }
  }
  return "unknown";
}

/**
 * Determine which config layer a system definition came from.
 * Project layer takes precedence for same-named systems.
 */
function findSystemOrigin(layers: ConfigLayer[], name: string): string {
  for (const layer of [...layers].reverse()) {
    if (layer.config && name in layer.config.systems) {
      return layer.scope;
    }
  }
  return "unknown";
}

/** Return active environment variable overrides that affect config resolution. */
function getActiveEnvOverrides(): { name: string; value: string }[] {
  const overrides: { name: string; value: string }[] = [];
  const vars = ["IBMI_SYSTEM", "DB2i_HOST", "DB2i_USER", "DB2i_PASS"];

  for (const name of vars) {
    const value = process.env[name];
    if (value) {
      overrides.push({ name, value: name.includes("PASS") ? "****" : value });
    }
  }

  return overrides;
}

/**
 * Register `ibmi config` subcommands.
 */
export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("Inspect CLI configuration");

  config
    .command("show")
    .description("Show active configuration with file origins")
    .action((_opts, cmd: Command) => {
      const format = getFormat(cmd);
      try {
        const layers = loadConfigLayers();
        const merged = loadConfig();
        const data: Record<string, unknown>[] = [];

        // File layer status
        const userPath = getUserConfigPath();
        const userLayer = layers.find((l) => l.scope === "user");
        data.push({
          PROPERTY: "[user]",
          VALUE: userLayer?.exists ? "loaded" : "not found",
          SOURCE: userPath,
        });

        const projectLayer = layers.find((l) => l.scope === "project");
        if (projectLayer) {
          data.push({
            PROPERTY: "[project]",
            VALUE: "loaded",
            SOURCE: projectLayer.path,
          });
        }

        // Top-level settings
        if (merged.default) {
          data.push({
            PROPERTY: "default",
            VALUE: merged.default,
            SOURCE: findOrigin(layers, "default"),
          });
        }

        if (merged.format) {
          data.push({
            PROPERTY: "format",
            VALUE: merged.format,
            SOURCE: findOrigin(layers, "format"),
          });
        }

        // Systems
        for (const [name, sys] of Object.entries(merged.systems)) {
          data.push({
            PROPERTY: `systems.${name}`,
            VALUE: `${sys.host}:${sys.port} (${sys.user})`,
            SOURCE: findSystemOrigin(layers, name),
          });
        }

        // Active env overrides
        for (const override of getActiveEnvOverrides()) {
          data.push({
            PROPERTY: override.name,
            VALUE: override.value,
            SOURCE: "environment",
          });
        }

        renderOutput(data, format, { rowCount: data.length });
      } catch (err) {
        renderError(
          err instanceof Error ? err : new Error(String(err)),
          format,
        );
        process.exitCode = ExitCode.GENERAL;
      }
    });
}
