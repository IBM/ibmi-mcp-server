/**
 * @fileoverview Opt-in dotenv loading for MCP server configuration.
 *
 * A dotenv file is loaded only when `MCP_SERVER_CONFIG` is set. The server
 * never searches cwd or parent directories for a `.env` file.
 *
 * @module src/config/loadDotenv
 */

import dotenv from "dotenv";
import { existsSync } from "fs";
import path from "path";

export interface LoadDotenvResult {
  loaded: boolean;
  path?: string;
}

/**
 * Load a dotenv file when `MCP_SERVER_CONFIG` points at one.
 *
 * @param env - Environment to read `MCP_SERVER_CONFIG` from. Defaults to `process.env`.
 * @returns Whether a file was loaded and its resolved path.
 * @throws If `MCP_SERVER_CONFIG` is set but the file does not exist.
 */
export function loadDotenvIfConfigured(
  env: NodeJS.ProcessEnv = process.env,
): LoadDotenvResult {
  const configPath = env.MCP_SERVER_CONFIG;
  if (!configPath) {
    return { loaded: false };
  }

  const resolved = path.resolve(configPath);
  if (!existsSync(resolved)) {
    throw new Error(
      `MCP_SERVER_CONFIG is set to "${resolved}" but the file does not exist.`,
    );
  }

  dotenv.config({ path: resolved });

  if (process.stdout.isTTY && env.MCP_LOG_LEVEL === "debug") {
    console.error(`Loaded configuration from MCP_SERVER_CONFIG: ${resolved}`);
  }

  return { loaded: true, path: resolved };
}
