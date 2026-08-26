/**
 * @fileoverview Zod schemas for validating CLI configuration files.
 * @module cli/config/schema
 */

import { z } from "zod";
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

/** Schema for a single system configuration entry. */
export const SystemConfigSchema = z.object({
  description: z.string().optional(),
  host: z.string().min(1, "host is required"),
  port: MapepirePortSchema.default(DEFAULT_MAPEPIRE_PORT),
  user: z.string().min(1, "user is required"),
  password: z.string().optional(),
  defaultSchema: z.string().optional(),
  readOnly: z.boolean().default(false),
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
