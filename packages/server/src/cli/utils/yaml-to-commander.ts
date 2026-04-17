/**
 * @fileoverview Maps YAML tool parameter definitions to Commander CLI options.
 * Handles snake_case → kebab-case conversion, type coercion, and reverse mapping.
 * @module cli/utils/yaml-to-commander
 */

import { Command } from "commander";
import type { YamlToolParameter } from "./yaml-loader.js";

/**
 * Convert a snake_case parameter name to a --kebab-case CLI flag.
 *
 * Examples:
 *   schema_name  → --schema-name <value>
 *   include_system → --include-system
 *   limit → --limit <n>
 */
function toOptionFlag(param: YamlToolParameter): string {
  const kebab = param.name.replace(/_/g, "-");
  if (param.type === "boolean") {
    return `--${kebab}`;
  }
  return `--${kebab} <value>`;
}

/**
 * Build a description string for a parameter, including enum/range hints.
 */
function buildDescription(param: YamlToolParameter): string {
  const parts: string[] = [];

  if (param.description) {
    parts.push(param.description);
  }

  if (param.enum && param.enum.length > 0) {
    const values = param.enum.map((v) => String(v)).join(", ");
    parts.push(`choices: ${values}`);
  }

  if (param.min !== undefined || param.max !== undefined) {
    const range = [
      param.min !== undefined ? `min: ${param.min}` : null,
      param.max !== undefined ? `max: ${param.max}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    parts.push(range);
  }

  return parts.join(". ") || param.name;
}

/**
 * Register YAML tool parameters as Commander options on a Command.
 * Each parameter becomes a typed CLI option with coercion and defaults.
 */
export function registerToolOptions(
  cmd: Command,
  params: YamlToolParameter[],
): void {
  for (const param of params) {
    const flag = toOptionFlag(param);
    const desc = buildDescription(param);

    switch (param.type) {
      case "boolean":
        cmd.option(flag, desc);
        break;

      case "integer":
        if (param.default !== undefined) {
          cmd.option(flag, desc, parseIntOption, param.default);
        } else {
          cmd.option(flag, desc, parseIntOption);
        }
        break;

      case "float":
        if (param.default !== undefined) {
          cmd.option(flag, desc, parseFloatOption, param.default);
        } else {
          cmd.option(flag, desc, parseFloatOption);
        }
        break;

      case "array":
        if (param.default !== undefined) {
          cmd.option(flag, desc, parseArrayOption, param.default);
        } else {
          cmd.option(flag, desc, parseArrayOption);
        }
        break;

      default:
        // string
        if (param.default !== undefined) {
          cmd.option(flag, desc, String(param.default));
        } else {
          cmd.option(flag, desc);
        }
        break;
    }
  }
}

/**
 * Commander parse function for integer options.
 */
function parseIntOption(value: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Expected an integer but got: ${value}`);
  }
  return parsed;
}

/**
 * Commander parse function for float options.
 */
function parseFloatOption(value: string): number {
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Expected a number but got: ${value}`);
  }
  return parsed;
}

/**
 * Commander parse function for array options (comma-separated).
 */
function parseArrayOption(value: string): string[] {
  return value.split(",").map((s) => s.trim());
}

/**
 * Convert Commander options (camelCase from --kebab-case) back to
 * snake_case parameter names for YAML tool execution.
 *
 * Commander converts --schema-name to opts.schemaName.
 * This maps it back to { schema_name: value }.
 */
export function optsToParams(
  opts: Record<string, unknown>,
  params: YamlToolParameter[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const param of params) {
    // Commander converts --kebab-case → camelCase
    const kebab = param.name.replace(/_/g, "-");
    const camel = kebabToCamel(kebab);

    if (opts[camel] !== undefined) {
      result[param.name] = opts[camel];
    }
  }

  return result;
}

/**
 * Convert kebab-case to camelCase (matching Commander's behavior).
 */
function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Validate required parameters are present.
 * Returns an array of missing required parameter names.
 */
export function validateRequiredParams(
  values: Record<string, unknown>,
  params: YamlToolParameter[],
): string[] {
  const missing: string[] = [];
  for (const param of params) {
    if (param.required && param.default === undefined && values[param.name] === undefined) {
      missing.push(param.name);
    }
  }
  return missing;
}
