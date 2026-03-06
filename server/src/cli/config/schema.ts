/**
 * @fileoverview Zod schemas for validating CLI configuration files.
 * @module cli/config/schema
 */

import { z } from "zod";

/** Schema for a single system configuration entry. */
export const SystemConfigSchema = z.object({
  description: z.string().optional(),
  host: z.string().min(1, "host is required"),
  port: z.coerce.number().int().positive().default(8076),
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
