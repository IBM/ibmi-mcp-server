#!/usr/bin/env node

/**
 * Propagate the root package.json version into every workspace package so both
 * @ibm/ibmi-mcp-server and @ibm/ibmi-cli publish with the same version on each
 * release. Also rewrites @ibm/ibmi-cli's dep on @ibm/ibmi-mcp-server to the
 * exact root version (no caret) — this pin is the install-time guarantee that
 * users never end up with mismatched halves.
 *
 * Runs at the end of `npm run release:*`. After this script, `npm install`
 * regenerates package-lock.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPkgPath = path.join(repoRoot, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
const version = rootPkg.version;

if (!version) {
  console.error("sync-workspace-versions: root package.json has no version");
  process.exit(1);
}

const SERVER_NAME = "@ibm/ibmi-mcp-server";
const CLI_NAME = "@ibm/ibmi-cli";

const targets = [
  {
    name: SERVER_NAME,
    path: path.join(repoRoot, "packages", "server", "package.json"),
  },
  {
    name: CLI_NAME,
    path: path.join(repoRoot, "packages", "cli", "package.json"),
    pinServerDep: true,
  },
];

for (const { name, path: pkgPath, pinServerDep } of targets) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.name !== name) {
    console.error(`sync-workspace-versions: expected ${name} at ${pkgPath}, found ${pkg.name}`);
    process.exit(1);
  }

  const before = pkg.version;
  pkg.version = version;

  if (pinServerDep && pkg.dependencies && pkg.dependencies[SERVER_NAME]) {
    pkg.dependencies[SERVER_NAME] = version;
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ${name}: ${before} -> ${version}`);
}

console.log("Refreshing package-lock.json...");
execSync("npm install --package-lock-only --ignore-scripts", {
  cwd: repoRoot,
  stdio: "inherit",
});

console.log(`\nAll workspace packages synced to v${version}.`);
