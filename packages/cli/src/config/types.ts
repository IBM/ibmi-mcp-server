/**
 * @fileoverview TypeScript types for the IBM i CLI configuration system.
 * @module cli/config/types
 */

/** Connection configuration for a single IBM i system. */
export interface SystemConfig {
  /** Human-readable description of this system. */
  description?: string;
  /** Hostname or IP address of the IBM i system. */
  host: string;
  /** Mapepire WebSocket port. Default: 8076. */
  port: number;
  /** User profile for authentication. */
  user: string;
  /** Password (supports ${ENV_VAR} expansion). */
  password?: string;
  /** Default schema/library for queries. */
  defaultSchema?: string;
  /** Block mutation queries (INSERT, UPDATE, DELETE, DROP). */
  readOnly: boolean;
  /** Require interactive confirmation before executing queries. */
  confirm: boolean;
  /** Query execution timeout in seconds. */
  timeout: number;
  /** Maximum rows returned per query. */
  maxRows: number;
  /** Ignore unauthorized SSL certificates. */
  ignoreUnauthorized: boolean;
  /** Additional YAML tool files for this system. */
  tools?: string[];
}

/** Full CLI configuration file structure. */
export interface CliConfig {
  /** Name of the default system to use. */
  default?: string;
  /** Default output format (table, json, csv, markdown). Overrides TTY auto-detection. */
  format?: OutputFormat;
  /** Named system configurations. */
  systems: Record<string, SystemConfig>;
}

/** Resolved system context for a CLI command execution. */
export interface ResolvedSystem {
  /** The system name (from config, "env" for legacy env vars). */
  name: string;
  /** The resolved system configuration. */
  config: SystemConfig;
  /** How this system was resolved. */
  source: "flag" | "env" | "config-default" | "legacy-env";
}

/** Output format options. */
export type OutputFormat = "table" | "json" | "csv" | "markdown";

/** Global CLI options passed to every command. */
export interface GlobalOptions {
  system?: string;
  format?: OutputFormat;
  raw?: boolean;
  noColor?: boolean;
}
