/**
 * @fileoverview The version of the installed `@ibm/ibmi-cli` package.
 * @module cli/version
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

let cached: string | undefined;

/** The version in this package's package.json, or "0.0.0" if it is not found. */
export function getVersion(): string {
  if (cached) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf-8"),
      );
      if (pkg.name === "@ibm/ibmi-cli") {
        cached = pkg.version as string;
        return cached;
      }
    } catch {
      // Not here, look one directory up
    }
    dir = path.dirname(dir);
  }
  cached = "0.0.0";
  return cached;
}
