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
 * Prompt the user for a line of visible input (e.g. a y/N confirmation).
 * The prompt is written to stderr so it doesn't interfere with piped output.
 */
export async function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    // Without these, Ctrl+C or end of input would leave the promise pending
    // and the process would exit 0 without an answer.
    rl.once("SIGINT", () => {
      reject(new Error("Cancelled"));
      rl.close();
    });
    rl.once("close", () => resolve(""));
    rl.question(prompt, (answer) => {
      resolve(answer);
      rl.close();
    });
  });
}

/**
 * Prompt the user for a password interactively (hidden input).
 * Returns the entered password string.
 */
export async function promptPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    // Non-interactive: read a line without echoing it back
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: stdin,
        output: process.stderr, // Use stderr so it doesn't interfere with piped output
        terminal: false,
      });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  // Interactive: read keypresses in raw mode so nothing is echoed. No readline
  // interface is attached here, because a terminal-mode interface echoes input.
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let password = "";
    const finish = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      // A chunk can hold several characters (paste, fast typing)
      for (const c of chunk.toString("utf8")) {
        if (c === "\n" || c === "\r" || c === "\u0004") {
          // Enter or Ctrl+D
          finish();
          resolve(password);
          return;
        }
        if (c === "\u0003") {
          // Ctrl+C — throw to let withConnection's finally block run cleanup
          finish();
          reject(new Error("Cancelled"));
          return;
        }
        if (c === "\u007f" || c === "\b") {
          // Backspace
          password = password.slice(0, -1);
        } else {
          password += c;
        }
      }
    };
    stdin.on("data", onData);
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
