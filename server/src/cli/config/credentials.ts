/**
 * @fileoverview Credential management for the IBM i CLI.
 * Handles environment variable expansion in config values and interactive password prompting.
 * @module cli/config/credentials
 */

import * as readline from "readline";

/**
 * Expand ${ENV_VAR} references in a string value.
 * Returns the original string if no env var pattern is found or the var is not set.
 */
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      return _match; // Leave unexpanded if not set
    }
    return envValue;
  });
}

/**
 * Prompt the user for a password interactively (hidden input).
 * Returns the entered password string.
 */
export async function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr, // Use stderr so it doesn't interfere with piped output
      terminal: true,
    });

    // Disable echoing for password entry
    if (process.stdin.isTTY) {
      process.stderr.write(prompt);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);

      let password = "";
      const onData = (char: Buffer) => {
        const c = char.toString("utf8");
        if (c === "\n" || c === "\r") {
          stdin.setRawMode(wasRaw ?? false);
          stdin.removeListener("data", onData);
          process.stderr.write("\n");
          rl.close();
          resolve(password);
        } else if (c === "\u0003") {
          // Ctrl+C
          stdin.setRawMode(wasRaw ?? false);
          stdin.removeListener("data", onData);
          rl.close();
          process.exit(1);
        } else if (c === "\u007f" || c === "\b") {
          // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
          }
        } else {
          password += c;
        }
      };
      stdin.on("data", onData);
    } else {
      // Non-interactive: read a line
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/**
 * Resolve the password for a system config.
 * Priority: config password (with env expansion) → interactive prompt.
 */
export async function resolvePassword(
  systemName: string,
  configPassword: string | undefined,
  user: string,
  host: string,
): Promise<string> {
  if (configPassword) {
    const expanded = expandEnvVars(configPassword);
    // If expansion resolved to a non-empty value, use it
    if (expanded && !expanded.includes("${")) {
      return expanded;
    }
  }

  // Fall back to interactive prompt
  if (!process.stdin.isTTY) {
    throw new Error(
      `No password configured for system "${systemName}" and stdin is not a terminal. ` +
        `Set the password in config or via environment variable.`,
    );
  }

  return promptPassword(`Password for ${user}@${host} [${systemName}]: `);
}
