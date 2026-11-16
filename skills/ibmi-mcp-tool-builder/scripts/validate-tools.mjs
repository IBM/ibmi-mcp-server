#!/usr/bin/env node
/**
 * Validate IBM i MCP Server YAML tool files against the SQL tools JSON schema,
 * plus the checks the schema can't express (source/toolset references and
 * :param bindings). Mirrors how the server loads YAML: ${VAR} is replaced from
 * the environment inside string values, after parsing.
 *
 * Usage:
 *   node validate-tools.mjs <file-or-dir> [more...] [--schema <path>]
 *   node --env-file=.env validate-tools.mjs tools/my-tools.yaml
 *
 * Exit codes: 0 = valid (warnings allowed), 1 = errors found, 2 = usage/setup error.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, extname, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = join(SCRIPT_DIR, "../assets/sql-tools-config.json");

let Ajv, yaml;
try {
  Ajv = (await import("ajv")).default;
  yaml = await import("js-yaml");
} catch {
  console.error(
    `Missing dependencies (ajv, js-yaml). Run: npm install --prefix "${SCRIPT_DIR}"`,
  );
  process.exit(2);
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { schema: { type: "string", default: DEFAULT_SCHEMA } },
});

if (positionals.length === 0) {
  console.error(
    "Usage: node validate-tools.mjs <file-or-dir> [more...] [--schema <path>]",
  );
  process.exit(2);
}
if (!existsSync(opts.schema)) {
  console.error(`Schema not found: ${opts.schema} (pass --schema <path>)`);
  process.exit(2);
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(
  JSON.parse(readFileSync(opts.schema, "utf8")),
);

function collectYamlFiles(target) {
  const path = resolve(target);
  if (!existsSync(path)) throw new Error(`Path not found: ${target}`);
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { recursive: true })
    .map((p) => join(path, p))
    .filter((p) => [".yaml", ".yml"].includes(extname(p)) && statSync(p).isFile());
}

// Same substitution the server performs (configParser.interpolateEnvironmentVariables),
// in string values of the parsed document. The server refuses to load a file
// that references an unset variable; here it keeps its ${VAR} placeholder and
// is reported at the end, so a file can be checked without credentials.
function interpolate(value, unsetVars) {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (match, name) => {
      if (process.env[name] !== undefined) return process.env[name];
      unsetVars.add(name);
      return match;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, unsetVars));
  if (value?.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v, unsetVars)]),
    );
  }
  return value;
}

function formatAjvError(err) {
  const where = err.instancePath || "(root)";
  if (err.keyword === "additionalProperties") {
    return `${where}: unknown property "${err.params.additionalProperty}"`;
  }
  if (err.keyword === "enum") {
    return `${where}: ${err.message} (${err.params.allowedValues.join(", ")})`;
  }
  return `${where}: ${err.message}`;
}

// Same masking the server applies before it looks for parameter markers
// (sqlTextMask.ts): string literals, delimited identifiers and comments become
// spaces, so offsets in the result match offsets in the statement.
const codeOnly = (sql) =>
  sql.replace(
    /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*(?:'|$)|"(?:[^"]|"")*(?:"|$)/g,
    (m) => m.replace(/[^\n\r]/g, " "),
  );

function checkStatement(toolName, tool, report) {
  const { statement } = tool;
  const params = tool.parameters ?? [];
  const at = `tools.${toolName}`;

  // The server looks for markers with /:(\w+)/g (parameterProcessor.ts) after
  // masking literals and comments, so we do too. With no parameters it sends
  // the SQL as-is.
  const code = codeOnly(statement);
  if (params.length === 0) {
    for (const m of code.matchAll(/:([A-Za-z_]\w*)/g)) {
      report.error(
        `${at}: statement uses ":${m[1]}" but the tool declares no parameters (the SQL would be sent unbound)`,
      );
    }
  }

  const placeholders = [...code.matchAll(/:(\w+)/g)].map((m) => ({
    name: m[1],
    index: m.index,
  }));
  const used = new Set(placeholders.map((p) => p.name));
  const declared = new Map(params.map((p) => [p.name, p]));

  for (const name of params.length ? used : []) {
    if (/^\d/.test(name)) {
      report.error(
        `${at}: ":${name}" is rejected by the server (named parameters must start with a letter); avoid ':' followed by a digit outside string literals and comments`,
      );
    } else if (!declared.has(name)) {
      report.error(`${at}: ":${name}" is not declared in parameters`);
    }
  }

  for (const [name, p] of declared) {
    if (!used.has(name)) {
      report.warn(`${at}: parameter "${name}" is declared but never used in the statement`);
      continue;
    }
    // An omitted optional parameter without a default is bound as SQL NULL.
    if (
      p.default !== undefined &&
      new RegExp(`:${name}\\s+IS\\s+(NOT\\s+)?NULL`, "i").test(code)
    ) {
      report.warn(
        `${at}: ":${name} IS [NOT] NULL" is constant; "${name}" has a default, so it is never bound as NULL`,
      );
    }
    if (p.type === "array") {
      for (const ph of placeholders.filter((x) => x.name === name)) {
        if (!/\(\s*$/.test(statement.slice(0, ph.index))) {
          report.warn(
            `${at}: array parameter ":${name}" expands to "?, ?, ..." and should be wrapped in parentheses, e.g. IN (:${name})`,
          );
        }
      }
    }
  }

  if (/\?/.test(code)) {
    if (placeholders.length > 0) {
      report.error(
        `${at}: statement mixes named (:name) and positional (?) parameter markers; the server refuses to load it`,
      );
    } else {
      report.warn(`${at}: positional "?" placeholders found; prefer named :params`);
    }
  }

  const firstWord = statement.trim().split(/\s+/)[0].toUpperCase();
  if (tool.security?.readOnly !== false && !["SELECT", "WITH", "VALUES"].includes(firstWord)) {
    report.warn(
      `${at}: statement starts with ${firstWord} but security.readOnly is not false; the server treats it as a write and will reject it`,
    );
  }
}

const files = positionals.flatMap(collectYamlFiles);
const configs = [];
const unsetVars = new Set();
let errorCount = 0;
let warnCount = 0;

for (const file of files) {
  const rel = relative(process.cwd(), file);
  const errors = [];
  const warnings = [];
  const report = { error: (m) => errors.push(m), warn: (m) => warnings.push(m) };

  let config;
  try {
    config = interpolate(yaml.load(readFileSync(file, "utf8")), unsetVars);
  } catch (e) {
    errors.push(`YAML parse error: ${e.message}`);
  }

  if (config !== undefined && errors.length === 0) {
    if (!config || typeof config !== "object") {
      errors.push("file is empty or not a YAML mapping");
    } else if (!validateSchema(config)) {
      errors.push(...validateSchema.errors.map(formatAjvError));
    } else if (!config.sources && !config.tools && !config.toolsets) {
      errors.push("must contain at least one of: sources, tools, toolsets");
    } else {
      for (const [name, tool] of Object.entries(config.tools ?? {})) {
        checkStatement(name, tool, report);
      }
      configs.push({ rel, config });
    }
  }

  const status = errors.length ? "FAIL" : warnings.length ? "WARN" : "OK";
  console.log(`${status.padEnd(4)}  ${rel}`);
  errors.forEach((m) => console.log(`      error: ${m}`));
  warnings.forEach((m) => console.log(`      warn:  ${m}`));
  errorCount += errors.length;
  warnCount += warnings.length;
}

// Cross-file references: the server merges every file passed via --tools.
const sources = new Set(configs.flatMap((c) => Object.keys(c.config.sources ?? {})));
const tools = new Set(configs.flatMap((c) => Object.keys(c.config.tools ?? {})));
const crossErrors = [];
for (const { rel, config } of configs) {
  for (const [name, tool] of Object.entries(config.tools ?? {})) {
    if (!sources.has(tool.source)) {
      crossErrors.push(`${rel}: tools.${name} references unknown source "${tool.source}"`);
    }
  }
  for (const [name, ts] of Object.entries(config.toolsets ?? {})) {
    for (const t of ts.tools) {
      if (!tools.has(t)) crossErrors.push(`${rel}: toolsets.${name} references unknown tool "${t}"`);
    }
  }
}
if (crossErrors.length) {
  console.log("FAIL  cross-file references");
  crossErrors.forEach((m) => console.log(`      error: ${m}`));
  errorCount += crossErrors.length;
}

if (unsetVars.size > 0) {
  console.log(
    `\nnote: unset environment variables left as \${...}: ${[...unsetVars].join(", ")} (the server refuses to start without them; try node --env-file=.env ...)`,
  );
}

console.log(
  `\n${files.length} file(s), ${tools.size} tool(s): ${errorCount} error(s), ${warnCount} warning(s)`,
);
process.exit(errorCount > 0 ? 1 : 0);
