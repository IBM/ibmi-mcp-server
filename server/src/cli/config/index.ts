/**
 * @fileoverview Barrel export for CLI configuration modules.
 * @module cli/config
 */

export { CliConfigSchema, SystemConfigSchema, validateConfig } from "./schema.js";
export {
  loadConfig,
  saveUserConfig,
  upsertSystem,
  removeSystem,
  setDefaultSystem,
  getProjectConfigPath,
  getUserConfigPath,
} from "./loader.js";
export { resolveSystem } from "./resolver.js";
export {
  expandEnvVars,
  promptPassword,
  resolvePassword,
} from "./credentials.js";
export type {
  CliConfig,
  SystemConfig,
  ResolvedSystem,
  OutputFormat,
  GlobalOptions,
} from "./types.js";
