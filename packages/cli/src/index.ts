#!/usr/bin/env node

/**
 * @fileoverview Entry point for the IBM i CLI (`ibmi`).
 * Provides a human-friendly and agent-friendly command-line interface to IBM i systems,
 * reusing the same tool infrastructure as the MCP server.
 * @module cli/index
 */

import { createProgram } from "./program.js";

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const program = createProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    // Commander handles most errors, but catch anything unexpected
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1; // Top-level catch uses code 1 (general)
  }
}

main();
