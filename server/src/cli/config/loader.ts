/**
 * @fileoverview Configuration file loader for the IBM i CLI.
 * Finds and parses .ibmi/config.yaml from project and user directories,
 * merging them with project-level taking precedence.
 * @module cli/config/loader
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import yaml from "js-yaml";
import { CliConfigSchema, validateConfig } from "./schema.js";
import { expandEnvVars } from "./credentials.js";
import type { CliConfig, SystemConfig } from "./types.js";

/** Default config file name. */
const CONFIG_FILE = "config.yaml";

/** Project-level config directory. */
const PROJECT_CONFIG_DIR = ".ibmi";

/** User-level config directory. */
const USER_CONFIG_DIR = path.join(homedir(), ".ibmi");

/**
 * Walk up from cwd to find the nearest .ibmi/config.yaml.
 * Stops at the filesystem root. Returns null if not found.
 */
function findProjectConfigPath(): string | null {
  let dir = process.cwd();
  const root = path.parse(dir).root;

  while (true) {
    const candidate = path.join(dir, PROJECT_CONFIG_DIR, CONFIG_FILE);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) {
      return null;
    }
    dir = parent;
  }
}

/** Get the project-level config file path (nearest .ibmi/config.yaml walking up from cwd). */
export function getProjectConfigPath(): string {
  return findProjectConfigPath() ?? path.join(process.cwd(), PROJECT_CONFIG_DIR, CONFIG_FILE);
}

/** Get the user-level config file path. */
export function getUserConfigPath(): string {
  return path.join(USER_CONFIG_DIR, CONFIG_FILE);
}

/**
 * Load and parse a single YAML config file.
 * Returns null if file doesn't exist.
 */
function loadConfigFile(filePath: string): CliConfig | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = readFileSync(filePath, "utf-8");
  const parsed = yaml.load(raw);

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const result = CliConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config at ${filePath}:\n${errors}`);
  }

  return result.data as CliConfig;
}

/**
 * Expand environment variables in all system configs.
 */
function expandSystemEnvVars(config: CliConfig): CliConfig {
  const expanded: CliConfig = {
    default: config.default,
    format: config.format,
    systems: {},
  };

  for (const [name, system] of Object.entries(config.systems)) {
    expanded.systems[name] = {
      ...system,
      host: expandEnvVars(system.host),
      user: expandEnvVars(system.user),
      password: system.password ? expandEnvVars(system.password) : undefined,
    };
  }

  return expanded;
}

/**
 * Merge two configs. Source overrides target on a per-system basis.
 * Systems in source completely replace same-named systems in target.
 */
function mergeConfigs(target: CliConfig, source: CliConfig): CliConfig {
  return {
    default: source.default ?? target.default,
    format: source.format ?? target.format,
    systems: {
      ...target.systems,
      ...source.systems,
    },
  };
}

/**
 * Load the full CLI configuration by merging user-level and project-level configs.
 * Project-level config takes precedence over user-level.
 *
 * @returns The merged, validated, and env-expanded configuration.
 */
export function loadConfig(): CliConfig {
  const userConfig = loadConfigFile(getUserConfigPath());
  const projectConfig = loadConfigFile(getProjectConfigPath());

  let config: CliConfig;
  if (userConfig && projectConfig) {
    config = mergeConfigs(userConfig, projectConfig);
  } else if (projectConfig) {
    config = projectConfig;
  } else if (userConfig) {
    config = userConfig;
  } else {
    config = { systems: {} };
  }

  // Validate cross-references
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  return expandSystemEnvVars(config);
}

/**
 * Save a config to the user-level config file.
 */
export function saveUserConfig(config: CliConfig): void {
  const configDir = USER_CONFIG_DIR;
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const yamlStr = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });

  writeFileSync(getUserConfigPath(), yamlStr, "utf-8");
}

/**
 * Add or update a system in the user config.
 */
export function upsertSystem(
  name: string,
  system: SystemConfig,
): void {
  let config: CliConfig;
  try {
    config = loadConfigFile(getUserConfigPath()) ?? { systems: {} };
  } catch {
    config = { systems: {} };
  }

  config.systems[name] = system;

  // If this is the first system, make it the default
  if (!config.default && Object.keys(config.systems).length === 1) {
    config.default = name;
  }

  saveUserConfig(config);
}

/**
 * Remove a system from the user config.
 * @returns true if the system existed and was removed.
 */
export function removeSystem(name: string): boolean {
  let config: CliConfig;
  try {
    config = loadConfigFile(getUserConfigPath()) ?? { systems: {} };
  } catch {
    return false;
  }

  if (!(name in config.systems)) {
    return false;
  }

  delete config.systems[name];

  // Clear default if it pointed to the removed system
  if (config.default === name) {
    const remaining = Object.keys(config.systems);
    config.default = remaining.length > 0 ? remaining[0] : undefined;
  }

  saveUserConfig(config);
  return true;
}

/**
 * Set the default system in the user config.
 */
export function setDefaultSystem(name: string): void {
  let config: CliConfig;
  try {
    config = loadConfigFile(getUserConfigPath()) ?? { systems: {} };
  } catch {
    config = { systems: {} };
  }

  // Load project config to check if system exists there
  const fullConfig = loadConfig();
  if (!(name in fullConfig.systems)) {
    throw new Error(
      `System "${name}" not found. Available systems: ${Object.keys(fullConfig.systems).join(", ") || "(none)"}`,
    );
  }

  config.default = name;
  saveUserConfig(config);
}
