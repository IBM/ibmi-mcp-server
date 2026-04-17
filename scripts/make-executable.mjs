#!/usr/bin/env node

/**
 * Shared helper that chmod +x's one or more files from the caller's cwd.
 * Used by both packages/server and packages/cli `postbuild` scripts. On
 * Windows it exits 0 without doing anything.
 */

import { access, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EXECUTABLE_MODE = 0o755;

if (os.platform() === "win32") {
  process.exit(0);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("make-executable: no target files provided");
  process.exit(1);
}

const cwd = process.cwd();
let hadError = false;

for (const rel of targets) {
  const abs = path.resolve(cwd, rel);
  if (!abs.startsWith(cwd + path.sep) && abs !== cwd) {
    console.error(`make-executable: refusing path outside cwd: ${rel}`);
    hadError = true;
    continue;
  }
  try {
    await access(abs);
    await chmod(abs, EXECUTABLE_MODE);
    console.log(`chmod +x ${rel}`);
  } catch (err) {
    console.error(`make-executable: ${rel}: ${err instanceof Error ? err.message : err}`);
    hadError = true;
  }
}

process.exit(hadError ? 1 : 0);
