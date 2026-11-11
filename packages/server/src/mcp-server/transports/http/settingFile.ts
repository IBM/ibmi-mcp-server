/**
 * @fileoverview Reads a file that a setting names.
 * @module src/mcp-server/transports/http/settingFile
 */

import { readFileSync } from "node:fs";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";

/**
 * Reads the file a setting points at.
 *
 * @param name - The environment variable, for the error message.
 * @throws {McpError} `ConfigurationError` naming the variable when the file
 *   cannot be read.
 */
export function readSettingFile(name: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new McpError(
      JsonRpcErrorCode.ConfigurationError,
      `${name}: cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? "unreadable"}). Set ${name} to a file this process can read.`,
    );
  }
}
