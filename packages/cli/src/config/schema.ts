/**
 * @fileoverview Zod schemas for validating CLI configuration files.
 * @module cli/config/schema
 */

import { z } from "zod";
import type { ExecuteSqlAccess } from "@ibm/ibmi-mcp-server/tools";

/**
 * execute_sql guardrail modes, least to most permissive. The server's
 * `EXECUTE_SQL_ACCESS_LEVELS` (a test keeps them equal); a static value
 * import of the server barrel would load its config before the CLI sets
 * the DB2i_* connection variables.
 */
export const ACCESS_MODES = [
  "read",
  "read-call",
  "write",
] as const satisfies readonly ExecuteSqlAccess[];

/**
 * Default Mapepire daemon port.
 * Keep in sync with server `DEFAULT_MAPEPIRE_PORT` / mapepire-js `DEFAULT_PORT`.
 */
export const DEFAULT_MAPEPIRE_PORT = 8076;

/**
 * Shared Mapepire port constraints (env legacy fallback + ~/.ibmi config).
 * Keep in sync with server `MapepirePortSchema`.
 */
export const MapepirePortSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .describe("Mapepire daemon port (default: 8076)");

/** Blank env/config port values default to {@link DEFAULT_MAPEPIRE_PORT}. */
export const MapepirePortEnvSchema = z.preprocess(
  (val) => (val === "" || val === undefined || val === null ? undefined : val),
  MapepirePortSchema.default(DEFAULT_MAPEPIRE_PORT),
);

/** Schema for a single system configuration entry. */
export const SystemConfigSchema = z.object({
  description: z.string().optional(),
  host: z.string().min(1, "host is required"),
  port: MapepirePortEnvSchema,
  user: z.string().min(1, "user is required"),
  password: z.string().optional(),
  defaultSchema: z.string().optional(),
  /** execute_sql guardrail ceiling for this system (never a default). */
  access: z.enum(ACCESS_MODES).optional(),
  /**
   * @deprecated for `ibmi sql`: use `access: read`. `true` caps `ibmi sql`
   * at read; `ibmi tool` still reads it as its read-only override.
   */
  readOnly: z.boolean().default(false),
  /** Keyword patterns (`*` wildcard) execute_sql rejects in every mode. */
  forbiddenKeywords: z.array(z.string().min(1)).optional(),
  confirm: z.boolean().default(false),
  timeout: z.coerce.number().int().positive().default(60),
  maxRows: z.coerce.number().int().positive().default(5000),
  ignoreUnauthorized: z.boolean().default(true),
  tools: z.array(z.string()).optional(),
});

/** Valid output format values. */
const OutputFormatEnum = z.enum(["table", "json", "csv", "markdown"]);

/** Schema for the full CLI config file. */
export const CliConfigSchema = z.object({
  default: z.string().optional(),
  format: OutputFormatEnum.optional(),
  systems: z.record(z.string(), SystemConfigSchema).default({}),
});

/** Validate that the default system references an existing system. */
export function validateConfig(
  config: z.infer<typeof CliConfigSchema>,
): string[] {
  const errors: string[] = [];

  if (config.default && !config.systems[config.default]) {
    errors.push(
      `Default system "${config.default}" is not defined in systems. Available: ${Object.keys(config.systems).join(", ") || "(none)"}`,
    );
  }

  return errors;
}
