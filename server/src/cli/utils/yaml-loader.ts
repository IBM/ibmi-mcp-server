/**
 * @fileoverview Lightweight YAML tool configuration loader for CLI.
 * Reads and parses YAML tool files without pulling in the full MCP server stack.
 * Used by discovery commands (ibmi tools, ibmi toolsets) and tool execution.
 * @module cli/utils/yaml-loader
 */

import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { load as yamlLoad } from "js-yaml";

/** Parameter definition from a YAML tool config. */
export interface YamlToolParameter {
  name: string;
  type: "string" | "boolean" | "integer" | "float" | "array";
  description?: string;
  required?: boolean;
  default?: string | number | boolean | unknown[] | null;
  enum?: Array<string | number | boolean>;
  itemType?: "string" | "boolean" | "integer" | "float";
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** Security config from a YAML tool. */
export interface YamlToolSecurity {
  readOnly?: boolean;
  maxQueryLength?: number;
  forbiddenKeywords?: string[];
}

/** A single tool definition loaded from YAML. */
export interface YamlToolConfig {
  source: string;
  description: string;
  statement?: string;
  parameters: YamlToolParameter[];
  security?: YamlToolSecurity;
  responseFormat?: string;
  tableFormat?: string;
  maxDisplayRows?: number;
  enabled?: boolean;
  annotations?: Record<string, unknown>;
}

/** Toolset definition from YAML. */
export interface YamlToolsetConfig {
  title?: string;
  description?: string;
  tools: string[];
}

/** Complete YAML tools configuration. */
export interface YamlToolsConfig {
  tools: Record<string, YamlToolConfig>;
  toolsets: Record<string, YamlToolsetConfig>;
  sources: Record<string, Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

/**
 * Interpolate ${ENV_VAR} references in a string.
 */
function interpolateEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    return process.env[varName.trim()] ?? "";
  });
}

/**
 * Load and parse a single YAML tool file.
 * Performs env var interpolation but no Zod validation (lightweight).
 */
export function loadYamlFile(filePath: string): YamlToolsConfig {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`YAML tool file not found: ${resolved}`);
  }

  const content = readFileSync(resolved, "utf-8");
  const interpolated = interpolateEnvVars(content);
  const parsed = yamlLoad(interpolated) as Record<string, unknown>;

  return {
    tools: normalizeTools(parsed["tools"] as Record<string, unknown> | undefined),
    toolsets: (parsed["toolsets"] ?? {}) as Record<string, YamlToolsetConfig>,
    sources: (parsed["sources"] ?? {}) as Record<string, Record<string, unknown>>,
    metadata: parsed["metadata"] as Record<string, unknown> | undefined,
  };
}

/**
 * Normalize raw tool entries to ensure parameters is always an array.
 */
function normalizeTools(
  raw: Record<string, unknown> | undefined,
): Record<string, YamlToolConfig> {
  if (!raw) return {};
  const result: Record<string, YamlToolConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const tool = value as Record<string, unknown>;
    result[name] = {
      source: (tool["source"] as string) ?? "",
      description: (tool["description"] as string) ?? "",
      statement: tool["statement"] as string | undefined,
      parameters: Array.isArray(tool["parameters"]) ? tool["parameters"] as YamlToolParameter[] : [],
      security: tool["security"] as YamlToolSecurity | undefined,
      responseFormat: tool["responseFormat"] as string | undefined,
      tableFormat: tool["tableFormat"] as string | undefined,
      maxDisplayRows: tool["maxDisplayRows"] as number | undefined,
      enabled: tool["enabled"] as boolean | undefined,
      annotations: tool["annotations"] as Record<string, unknown> | undefined,
    };
  }
  return result;
}

/**
 * Load YAML tools from one or more paths.
 * Accepts file paths, directories (scans for *.yaml/*.yml), or comma-separated lists.
 * Merges all configs together, with later files overriding earlier ones.
 */
export function loadYamlTools(paths: string[]): YamlToolsConfig {
  const merged: YamlToolsConfig = {
    tools: {},
    toolsets: {},
    sources: {},
  };

  for (const p of paths) {
    const resolved = resolve(p.trim());
    const filePaths = resolveToFiles(resolved);

    for (const filePath of filePaths) {
      const config = loadYamlFile(filePath);
      Object.assign(merged.tools, config.tools);
      Object.assign(merged.toolsets, config.toolsets);
      Object.assign(merged.sources, config.sources);
      if (config.metadata) {
        merged.metadata = { ...(merged.metadata ?? {}), ...config.metadata };
      }
    }
  }

  return merged;
}

/**
 * Resolve a path to a list of YAML files.
 * If it's a file, returns [file]. If directory, scans for *.yaml/*.yml recursively.
 */
function resolveToFiles(p: string): string[] {
  if (!existsSync(p)) {
    throw new Error(`Path not found: ${p}`);
  }

  const stat = statSync(p);
  if (stat.isFile()) {
    return [p];
  }

  if (stat.isDirectory()) {
    return scanDirectory(p);
  }

  return [];
}

/**
 * Recursively scan a directory for YAML files.
 */
function scanDirectory(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanDirectory(fullPath));
    } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Build a reverse map from tool name → toolset names.
 */
export function buildToolsetMap(
  toolsets: Record<string, YamlToolsetConfig>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [tsName, tsConfig] of Object.entries(toolsets)) {
    for (const toolName of tsConfig.tools) {
      const existing = map.get(toolName) ?? [];
      existing.push(tsName);
      map.set(toolName, existing);
    }
  }
  return map;
}
