/**
 * @fileoverview Loads, validates, and exports application configuration.
 * This module centralizes configuration management, sourcing values from
 * environment variables and `package.json`. It uses Zod for schema validation
 * to ensure type safety and correctness of configuration parameters.
 *
 * @module src/config/index
 */

import dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { isIP } from "net";
import { homedir } from "os";
import path, { dirname, join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import type { JDBCOptions } from "@ibm/mapepire-js";
import {
  DEFAULT_MAPEPIRE_PORT,
  MapepirePortEnvSchema,
} from "@/ibmi-mcp-server/schemas/common.js";

export { DEFAULT_MAPEPIRE_PORT };
// .env: the file named by MCP_SERVER_CONFIG, otherwise <cwd>/.env.
let envPath = path.resolve(process.cwd(), ".env");

if (process.env.MCP_SERVER_CONFIG) {
  const configPath = path.resolve(process.env.MCP_SERVER_CONFIG);
  if (existsSync(configPath)) {
    envPath = configPath;
  } else {
    console.error(
      `Warning: MCP_SERVER_CONFIG is set to "${configPath}" but file does not exist. Falling back to ${envPath}.`,
    );
  }
}

if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
  if (process.stdout.isTTY && process.env.MCP_LOG_LEVEL === "debug") {
    console.error(`Loaded .env from: ${envPath}`);
  }
}

// --- Determine Project Root ---
const findProjectRoot = (startDir: string): string => {
  let currentDir = startDir;
  // If the start directory is in `dist`, start searching from the parent directory.
  if (path.basename(currentDir) === "dist") {
    currentDir = path.dirname(currentDir);
  }
  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        `Could not find project root (package.json) starting from ${startDir}`,
      );
    }
    currentDir = parentDir;
  }
};
let projectRoot: string;
try {
  const currentModuleDir = dirname(fileURLToPath(import.meta.url));
  projectRoot = findProjectRoot(currentModuleDir);
} catch (error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`FATAL: Error determining project root: ${errorMessage}`);
  projectRoot = process.cwd();
  if (process.stdout.isTTY) {
    console.warn(
      `Warning: Using process.cwd() (${projectRoot}) as fallback project root.`,
    );
  }
}
// --- End Determine Project Root ---

/**
 * Loads and parses the package.json file from the project root.
 * @returns The parsed package.json object or a fallback default.
 * @private
 */
const loadPackageJson = (): { name: string; version: string } => {
  const pkgPath = join(projectRoot, "package.json");
  const fallback = { name: "ibmi-mcp-server", version: "1.0.0" };

  if (!existsSync(pkgPath)) {
    if (process.stdout.isTTY) {
      console.warn(
        `Warning: package.json not found at ${pkgPath}. Using fallback values. This is expected in some environments (e.g., Docker) but may indicate an issue with project root detection.`,
      );
    }
    return fallback;
  }

  try {
    const fileContents = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(fileContents);
    return {
      name: typeof parsed.name === "string" ? parsed.name : fallback.name,
      version:
        typeof parsed.version === "string" ? parsed.version : fallback.version,
    };
  } catch (error) {
    if (process.stdout.isTTY) {
      console.error(
        "Warning: Could not read or parse package.json. Using hardcoded defaults.",
        error,
      );
    }
    return fallback;
  }
};

const pkg = loadPackageJson();

/** Shared schema for `DB2i_PORT` (startup env + runtime `config.db2i` getter). */
const Db2iPortSchema = MapepirePortEnvSchema;

/** Splits a list setting on commas, dropping blank entries. */
const splitList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/** An optional setting; blank counts as unset. */
const optionalSetting = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

/**
 * Reads one entry of a CIDR list as `address/prefix`. A bare address is the
 * single host (`/32`, `/128`).
 *
 * @returns `undefined` when the entry is not an IP address or range.
 */
function parseCidr(entry: string): string | undefined {
  const [address = "", prefix, ...rest] = entry.split("/");
  const family = isIP(address);
  if (
    family === 0 ||
    rest.length > 0 ||
    (prefix !== undefined && !/^\d{1,3}$/.test(prefix))
  ) {
    return undefined;
  }
  const maxPrefix = family === 4 ? 32 : 128;
  const bits = prefix === undefined ? maxPrefix : Number(prefix);
  return bits <= maxPrefix ? `${address}/${bits}` : undefined;
}

/**
 * A comma-separated list of IP addresses and CIDR ranges, each normalised to
 * `address/prefix`. Unset or blank gives `defaults`.
 */
const cidrList = (defaults: string[] = []) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      const entries = splitList(value);
      if (entries.length === 0) {
        return defaults;
      }
      return entries.map((entry) => {
        const cidr = parseCidr(entry);
        if (!cidr) {
          ctx.addIssue({
            code: "custom",
            message: `"${entry}" is not an IP address or a CIDR range such as 10.0.0.0/8.`,
          });
        }
        return cidr ?? entry;
      });
    });

/**
 * Who may reach the built-in sign-in page by default: loopback, the RFC 1918
 * private ranges and IPv6 unique-local addresses.
 */
const DEFAULT_SIGNON_ALLOWED_CIDRS = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
];

/** An IBM i user profile name, or the leading part of one followed by `*`. */
const PROFILE_PATTERN = /^(?:[A-Z0-9#$_]{1,10}|[A-Z0-9#$_]{1,9}\*)$/;

/** Host names of `MCP_RESOURCE_URL` that may use plain http. */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/**
 * The issuer of the built-in authorization server: `MCP_RESOURCE_URL` without
 * its last path segment (`https://h/mcp` gives `https://h`,
 * `https://h/ibmi/mcp` gives `https://h/ibmi`).
 */
function builtinIssuer(resourceUrl: string | undefined): string | undefined {
  if (!resourceUrl || !URL.canParse(resourceUrl)) {
    return undefined;
  }
  const url = new URL(resourceUrl);
  return url.origin + url.pathname.replace(/\/$/, "").replace(/\/[^/]*$/, "");
}

const EnvSchema = z.object({
  // --- Existing MCP and other variables ---
  MCP_SERVER_NAME: z.string().optional(),
  MCP_SERVER_VERSION: z.string().optional(),
  MCP_LOG_LEVEL: z
    .enum([
      "debug",
      "info",
      "notice",
      "warning",
      "warn",
      "error",
      "crit",
      "alert",
      "emerg",
    ])
    .default("debug"),
  LOGS_DIR: z
    .string()
    .default(path.join(homedir(), ".ibmi-mcp-server", "logs")),
  NODE_ENV: z.string().default("development"),
  MCP_TRANSPORT_TYPE: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(3010),
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),
  MCP_HTTP_ENDPOINT_PATH: z.string().default("/mcp"),
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_ALLOW_UNAUTHENTICATED_HTTP: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  /**
   * Addresses of the reverse proxies in front of the server, as a
   * comma-separated list of IP addresses and CIDR ranges. X-Forwarded-For and
   * X-Forwarded-Proto are believed only when the TCP peer is inside this
   * list. Default: none.
   */
  MCP_TRUSTED_PROXIES: cidrList(),
  /**
   * PEM certificate (chain) and private key files. When both are set the
   * HTTP server listens with TLS.
   */
  MCP_TLS_CERT_FILE: optionalSetting,
  MCP_TLS_KEY_FILE: optionalSetting,
  /**
   * HTTP authentication mode. `oauth` makes the server an OAuth 2.1 resource
   * server as defined by the MCP authorization specification; `ibmi` is the
   * deprecated IBM i token scheme; `none` disables authentication. The
   * retired `jwt` passes validation only so that it cannot invalidate the
   * rest of the environment; the server refuses to start with it.
   */
  MCP_AUTH_MODE: z.enum(["none", "oauth", "ibmi", "jwt"]).default("none"),
  // The OAuth settings are plain strings here and are validated when the HTTP
  // transport starts (transports/auth/oauth.ts), so a bad value stops the
  // server with a message naming the variable.
  /**
   * Canonical public URL of the MCP endpoint (RFC 8707 resource identifier),
   * e.g. `https://mcp.example.com/mcp`. Required when `MCP_AUTH_MODE=oauth`.
   */
  MCP_RESOURCE_URL: z.string().optional(),
  /**
   * Issuer of an external authorization server. With `MCP_AUTH_MODE=oauth`
   * and this unset, the server is its own authorization server and users
   * sign on with their IBM i profile.
   */
  OAUTH_ISSUER_URL: z.string().optional(),
  /** JWKS URL of the issuer. Default: discovered from the issuer's metadata. */
  OAUTH_JWKS_URI: z.string().optional(),
  /** Expected token audience. Default: `MCP_RESOURCE_URL`. */
  OAUTH_AUDIENCE: z.string().optional(),
  /** Space-separated scopes every request to the MCP endpoint must carry. */
  OAUTH_REQUIRED_SCOPES: z.string().optional(),

  // --- START: Built-in authorization server (MCP_AUTH_MODE=oauth without OAUTH_ISSUER_URL) ---
  /** Client addresses that may reach the sign-in page. */
  OAUTH_SIGNON_ALLOWED_CIDRS: cidrList(DEFAULT_SIGNON_ALLOWED_CIDRS),
  /**
   * Whether an authorization code sent to a loopback redirect must be
   * redeemed from the address that signed on (`strict`), or a mismatch is
   * only audited (`audit`).
   */
  OAUTH_CODE_ADDRESS_BINDING: z.enum(["strict", "audit"]).default("strict"),
  /** Longest a sign-on lasts, in hours. Default: 12. */
  OAUTH_GRANT_MAX_HOURS: z.coerce.number().int().positive().default(12),
  /** Idle minutes after which a user's IBM i connection is closed. Default: 10. */
  OAUTH_IDLE_CLOSE_MINUTES: z.coerce.number().int().positive().default(10),
  /** Most IBM i connections open at once. Default: 50. */
  OAUTH_MAX_CONNECTIONS: z.coerce.number().int().positive().default(50),
  /**
   * Comma-separated profiles that may sign on: exact names, or the leading
   * part of a name followed by `*`. Default: every profile not starting
   * with Q.
   */
  OAUTH_ALLOWED_PROFILES: z
    .string()
    .optional()
    .transform((value, ctx) =>
      splitList(value).map((entry) => {
        const profile = entry.toUpperCase();
        if (!PROFILE_PATTERN.test(profile)) {
          ctx.addIssue({
            code: "custom",
            message: `"${entry}" is not a profile name (up to 10 of A-Z 0-9 # $ _) or the start of one followed by *.`,
          });
        }
        return profile;
      }),
    ),
  /** Let profiles holding *ALLOBJ or *SECADM sign on. Default: false. */
  OAUTH_ALLOW_PRIVILEGED_PROFILES: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  /**
   * Rejected sign-ons after which a profile is blocked on this server.
   * Default: 2. Keep it below the system's QMAXSIGN.
   */
  OAUTH_SIGNON_MAX_FAILURES: z.coerce.number().int().min(1).default(2),
  /** Accept `http://localhost`, `127.0.0.1` and `[::1]` redirects. Default: true. */
  OAUTH_ALLOW_LOOPBACK_REDIRECTS: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val === "true" || val === "1"),
  /**
   * Redirect URIs accepted besides loopback ones, separated by commas or
   * white space. Each is matched exactly.
   */
  OAUTH_REDIRECT_URIS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      const uris = (value ?? "").split(/[\s,]+/).filter(Boolean);
      for (const uri of uris) {
        if (!URL.canParse(uri) || new URL(uri).hash) {
          ctx.addIssue({
            code: "custom",
            message: `"${uri}" is not an absolute URI without a fragment.`,
          });
        }
      }
      return uris;
    }),
  /** Path of the local admin socket (created with mode 0600). Default: none. */
  OAUTH_ADMIN_SOCKET: optionalSetting,
  // --- END: Built-in authorization server ---

  // --- START: OpenTelemetry Configuration ---
  /** If 'true', OpenTelemetry will be initialized and enabled. Default: 'false'. */
  OTEL_ENABLED: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default(false),
  /** The logical name of the service. Defaults to MCP_SERVER_NAME or package name. */
  OTEL_SERVICE_NAME: z.string().optional(),
  /** The version of the service. Defaults to MCP_SERVER_VERSION or package version. */
  OTEL_SERVICE_VERSION: z.string().optional(),
  /** The OTLP endpoint for traces. If not set, traces are logged to a file in development. */
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().url().optional(),
  /** The OTLP endpoint for metrics. If not set, metrics are not exported. */
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: z.string().url().optional(),
  /** Sampling ratio for traces (0.0 to 1.0). 1.0 means sample all. Default: 1.0 */
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(1.0),
  /** Log level for OpenTelemetry's internal diagnostic logger. Default: "INFO". */
  OTEL_LOG_LEVEL: z
    .enum(["NONE", "ERROR", "WARN", "INFO", "DEBUG", "VERBOSE", "ALL"])
    .default("INFO"),
  /** IBM i Mapepire daemon server host. From `DB2i_HOST`. */
  DB2i_HOST: z
    .string()
    .min(1, "DB2i_HOST is required for IBM i connections.")
    .optional(),
  /**
   * IBM i Mapepire daemon server port. From `DB2i_PORT`.
   * Defaults to 8076 when unset.
   */
  DB2i_PORT: Db2iPortSchema,
  /** IBM i DB2 user name. From `DB2i_USER`. */
  DB2i_USER: z
    .string()
    .min(1, "DB2i_USER is required for IBM i connections.")
    .optional(),
  /** IBM i DB2 password. From `DB2i_PASS`. */
  DB2i_PASS: z
    .string()
    .min(1, "DB2i_PASS is required for IBM i connections.")
    .optional(),
  /** Ignore unauthorized SSL certificates for Mapepire. From `DB2i_IGNORE_UNAUTHORIZED`. Default: true. */
  DB2i_IGNORE_UNAUTHORIZED: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val === "true" || val === "1"),

  /**
   * How the built-in authorization server verifies the Mapepire server's
   * certificate: the PEM of that exact certificate (`DB2i_SERVER_CERT_FILE`,
   * host name not checked) or a PEM CA bundle (`DB2i_CA_FILE`, host name
   * checked). With neither, Node's trust store is used, unless
   * `DB2i_IGNORE_UNAUTHORIZED=true` is set: that turns verification off and
   * cannot be combined with either file.
   */
  DB2i_SERVER_CERT_FILE: optionalSetting,
  DB2i_CA_FILE: optionalSetting,

  /**
   * Mapepire JDBC connection options. Semicolon-separated key=value pairs
   * modeled on DB2 JDBC URL syntax. From `DB2i_JDBC_OPTIONS`.
   * Example: `naming=system;date format=iso;libraries=MYLIB,DEVDATA`
   */
  DB2i_JDBC_OPTIONS: z.string().optional(),

  /** Path to YAML tools configuration file. From `TOOLS_YAML_PATH`. */
  TOOLS_YAML_PATH: z
    .string()
    .min(1, "TOOLS_YAML_PATH is required for YAML-based tools.")
    .optional(),

  /** YAML merge options configuration. From `YAML_MERGE_*` environment variables. */
  YAML_MERGE_ARRAYS: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val === "true"),
  YAML_ALLOW_DUPLICATE_TOOLS: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true"),
  YAML_ALLOW_DUPLICATE_SOURCES: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true"),
  YAML_VALIDATE_MERGED: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val === "true"),

  /**
   * IBM i HTTP token authentication. From `IBMI_HTTP_AUTH_ENABLED` and the
   * `IBMI_AUTH_*` environment variables below.
   * @deprecated IBM i HTTP token authentication will be removed in a future
   * major release. Use `MCP_AUTH_MODE=oauth`.
   */
  IBMI_HTTP_AUTH_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  IBMI_AUTH_ALLOW_HTTP: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  IBMI_AUTH_TOKEN_EXPIRY_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
  IBMI_AUTH_CLEANUP_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  IBMI_AUTH_MAX_CONCURRENT_SESSIONS: z.coerce
    .number()
    .int()
    .positive()
    .default(100),
  IBMI_AUTH_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  IBMI_AUTH_PUBLIC_KEY_PATH: z.string().min(1).optional(),
  IBMI_AUTH_KEY_ID: z.string().min(1).optional(),
  /**
   * Comma-separated IBM i host names `/api/v1/auth` may sign on to.
   * Default: `DB2i_HOST`.
   */
  IBMI_AUTH_ALLOWED_HOSTS: z.string().optional(),

  /** Enable automatic reloading of YAML tools when configuration files change. From `YAML_AUTO_RELOAD`. Default: true. */
  YAML_AUTO_RELOAD: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val === "true" || val === "1"),

  SELECTED_TOOLSETS: z.string().optional(),

  /**Enable built-in execute_sql tool for ad-hoc SELECT queries */
  IBMI_ENABLE_EXECUTE_SQL: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true"),

  /** Control readonly mode for execute_sql tool. When true (default), only SELECT queries are allowed. */
  IBMI_EXECUTE_SQL_READONLY: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val === "true" || val === "1"),

  /** Enable built-in default tools for text-to-SQL workflows (list_schemas, list_tables_in_schema, get_table_columns, validate_query). */
  IBMI_ENABLE_DEFAULT_TOOLS: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true" || val === "1"),

  // --- START: Rate Limiting Configuration ---
  /** Enable or disable HTTP rate limiting. Default: true. */
  MCP_RATE_LIMIT_ENABLED: z
    .string()
    .optional()
    .default("true")
    .transform((val) => val === "true" || val === "1"),

  /** Maximum requests allowed per rate limit window. Default: 100. */
  MCP_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

  /** Rate limit window duration in milliseconds. Default: 900000 (15 minutes). */
  MCP_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),

  /** Skip rate limiting when NODE_ENV=development. Default: false. */
  MCP_RATE_LIMIT_SKIP_DEV: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  // --- END: Rate Limiting Configuration ---

  // --- START: Connection Pool Timeout Configuration ---
  /** Idle timeout for Mapepire connection pools (ms). Pools closed after inactivity. Set to 0 to disable. Default: 300000 (5 minutes). */
  MCP_POOL_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(300_000),

  /** Query execution timeout (ms). Queries aborted after this period. Set to 0 to disable. Default: 30000 (30 seconds). */
  MCP_POOL_QUERY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(30_000),
  // --- END: Connection Pool Timeout Configuration ---

  // --- START: Pagination Configuration ---
  /**
   * Default page size for paginated SQL fetches (rows per fetchMore call).
   * Used when a tool sets fetchAllRows: true without specifying rowsToFetch.
   * Also the fetch size used by the built-in execute_sql tool.
   * Default: 1000.
   */
  IBMI_PAGINATION_DEFAULT_PAGE_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(1000),

  /**
   * Hard upper bound on total rows returned by a single paginated tool call.
   * The pagination loop stops once accumulated rows reach this value, even
   * if the result set has more data. Default: 30000.
   */
  IBMI_PAGINATION_MAX_ROWS: z.coerce.number().int().positive().default(30_000),
  // --- END: Pagination Configuration ---
});

/**
 * Settings that contradict each other. The other startup checks of the
 * built-in authorization server need more than the environment (the
 * transport after CLI overrides, readable files, the inspector) and run when
 * the server starts.
 */
const CheckedEnvSchema = EnvSchema.superRefine((env, ctx) => {
  const refuse = (name: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [name], message });

  if (!env.MCP_TLS_CERT_FILE !== !env.MCP_TLS_KEY_FILE) {
    refuse(
      env.MCP_TLS_CERT_FILE ? "MCP_TLS_KEY_FILE" : "MCP_TLS_CERT_FILE",
      "MCP_TLS_CERT_FILE and MCP_TLS_KEY_FILE must be set together.",
    );
  }
  if (env.DB2i_SERVER_CERT_FILE && env.DB2i_CA_FILE) {
    refuse(
      "DB2i_CA_FILE",
      "Set DB2i_SERVER_CERT_FILE (the exact certificate) or DB2i_CA_FILE (a CA bundle), not both.",
    );
  }

  if (env.MCP_AUTH_MODE !== "oauth" || env.OAUTH_ISSUER_URL) {
    return;
  }
  // From here on: the built-in authorization server.
  for (const name of ["OAUTH_JWKS_URI", "OAUTH_AUDIENCE"] as const) {
    if (env[name]) {
      refuse(
        name,
        `${name} applies to an external authorization server: set OAUTH_ISSUER_URL as well, or remove ${name} to use the built-in IBM i sign-on.`,
      );
    }
  }
  const resource = env.MCP_RESOURCE_URL;
  if (!resource) {
    refuse(
      "MCP_RESOURCE_URL",
      "MCP_RESOURCE_URL is required when MCP_AUTH_MODE=oauth.",
    );
  } else if (!URL.canParse(resource) || new URL(resource).hash) {
    refuse(
      "MCP_RESOURCE_URL",
      "MCP_RESOURCE_URL must be a URL without a fragment.",
    );
  } else {
    const url = new URL(resource);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && LOOPBACK_HOSTNAMES.includes(url.hostname))
    ) {
      refuse(
        "MCP_RESOURCE_URL",
        "MCP_RESOURCE_URL must use https unless it is a loopback address: without OAUTH_ISSUER_URL users type their IBM i password into a page served from it.",
      );
    }
  }
});

const parsedEnv = CheckedEnvSchema.safeParse(process.env);

if (!parsedEnv.success) {
  // Always report this (stderr is safe under the stdio transport): on failure
  // every environment-derived setting below falls back to its default.
  console.error(
    "❌ Invalid environment variables found; ALL environment-derived settings fall back to their defaults:",
    parsedEnv.error.flatten().fieldErrors,
  );
}

const env = parsedEnv.success ? parsedEnv.data : EnvSchema.parse({});

/**
 * Whether the environment passed validation. When it did not, every setting
 * has its default; the server refuses to start in that state.
 */
export const environmentIsValid = parsedEnv.success;

/**
 * Expands tilde (~) to user's home directory
 * @param filePath - Path that may contain ~
 * @returns Path with ~ expanded to home directory
 */
const expandTilde = (filePath: string): string => {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(homedir(), filePath.slice(1));
  }
  return filePath;
};

/**
 * Parse DB2i_JDBC_OPTIONS env var: a semicolon-separated list of key=value
 * pairs modeled on DB2 JDBC URL syntax.
 *
 * Example: `naming=system;date format=iso;libraries=MYLIB,DEVDATA`
 *
 * Rules:
 *   - `;` splits outer pairs; empty segments are ignored
 *   - First `=` in each pair splits key/value (values may contain `=`)
 *   - Whitespace around key and value is trimmed
 *   - `libraries` is comma-split into string[] (only array-valued JDBCOption)
 *   - All other values are forwarded as strings — mapepire's JDBC driver
 *     accepts string values for all options; no bool/number coercion
 *   - Malformed pairs (non-empty with no `=`) throw to surface typos early
 */
function parseJdbcOptionsString(raw: string): JDBCOptions | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const result: Record<string, unknown> = {};
  for (const segment of trimmed.split(";")) {
    const pair = segment.trim();
    if (!pair) continue;
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) {
      throw new Error(
        `Invalid DB2i_JDBC_OPTIONS: malformed pair "${pair}" — expected key=value`,
      );
    }
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (!key) {
      throw new Error(`Invalid DB2i_JDBC_OPTIONS: empty key in pair "${pair}"`);
    }
    if (key === "libraries") {
      result[key] = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? (result as JDBCOptions) : undefined;
}

export const config = {
  mcpServerName: env.MCP_SERVER_NAME || pkg.name,
  mcpServerVersion: env.MCP_SERVER_VERSION || pkg.version,
  logLevel: env.MCP_LOG_LEVEL,
  /**
   * Absolute path of `LOGS_DIR` (`~` expanded, relative paths resolved from
   * the working directory). The logger creates it on first use.
   */
  logsPath: path.resolve(expandTilde(env.LOGS_DIR)),
  environment: env.NODE_ENV,
  mcpTransportType: env.MCP_TRANSPORT_TYPE,
  mcpHttpPort: env.MCP_HTTP_PORT,
  mcpHttpHost: env.MCP_HTTP_HOST,
  mcpHttpEndpointPath: env.MCP_HTTP_ENDPOINT_PATH,
  mcpAllowedOrigins: env.MCP_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  mcpAllowedHosts: env.MCP_ALLOWED_HOSTS?.split(",")
    .map((host) => host.trim())
    .filter(Boolean),
  mcpAllowUnauthenticatedHttp: env.MCP_ALLOW_UNAUTHENTICATED_HTTP,
  /** `MCP_TRUSTED_PROXIES` as `address/prefix` entries. */
  mcpTrustedProxies: env.MCP_TRUSTED_PROXIES,
  mcpTlsCertFile: env.MCP_TLS_CERT_FILE,
  mcpTlsKeyFile: env.MCP_TLS_KEY_FILE,
  mcpAuthMode: env.MCP_AUTH_MODE,
  mcpResourceUrl: env.MCP_RESOURCE_URL,
  oauthIssuerUrl: env.OAUTH_ISSUER_URL,
  oauthJwksUri: env.OAUTH_JWKS_URI,
  oauthAudience: env.OAUTH_AUDIENCE,
  oauthRequiredScopes: env.OAUTH_REQUIRED_SCOPES?.split(/\s+/).filter(Boolean),
  /**
   * The built-in authorization server: users sign on with their IBM i
   * profile and SQL runs as that profile.
   */
  oauth: {
    /**
     * Whether the server is its own authorization server:
     * `MCP_AUTH_MODE=oauth` without `OAUTH_ISSUER_URL`.
     */
    get builtin(): boolean {
      return config.mcpAuthMode === "oauth" && !config.oauthIssuerUrl;
    },
    /**
     * Issuer of the built-in authorization server, derived from
     * `MCP_RESOURCE_URL`. Undefined unless `builtin`.
     */
    get issuer(): string | undefined {
      return this.builtin ? builtinIssuer(config.mcpResourceUrl) : undefined;
    },
    /** The Mapepire server users sign on to, and how it is verified. */
    mapepire: {
      host: env.DB2i_HOST,
      port: env.DB2i_PORT,
      serverCertFile: env.DB2i_SERVER_CERT_FILE,
      caFile: env.DB2i_CA_FILE,
    },
    /** `address/prefix` entries. */
    signOnAllowedCidrs: env.OAUTH_SIGNON_ALLOWED_CIDRS,
    codeAddressBinding: env.OAUTH_CODE_ADDRESS_BINDING,
    grantMaxHours: env.OAUTH_GRANT_MAX_HOURS,
    idleCloseMinutes: env.OAUTH_IDLE_CLOSE_MINUTES,
    maxConnections: env.OAUTH_MAX_CONNECTIONS,
    /** Upper-case names and `PREFIX*` patterns; empty when unset. */
    allowedProfiles: env.OAUTH_ALLOWED_PROFILES,
    allowPrivilegedProfiles: env.OAUTH_ALLOW_PRIVILEGED_PROFILES,
    signOnMaxFailures: env.OAUTH_SIGNON_MAX_FAILURES,
    allowLoopbackRedirects: env.OAUTH_ALLOW_LOOPBACK_REDIRECTS,
    redirectUris: env.OAUTH_REDIRECT_URIS,
    adminSocket: env.OAUTH_ADMIN_SOCKET,
  },
  openTelemetry: {
    enabled: env.OTEL_ENABLED,
    serviceName: env.OTEL_SERVICE_NAME || env.MCP_SERVER_NAME || pkg.name,
    serviceVersion:
      env.OTEL_SERVICE_VERSION || env.MCP_SERVER_VERSION || pkg.version,
    tracesEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    metricsEndpoint: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    samplingRatio: env.OTEL_TRACES_SAMPLER_ARG,
    logLevel: env.OTEL_LOG_LEVEL,
  },

  /**
   * JDBC options parsed from `DB2i_JDBC_OPTIONS`. Independent of the service
   * account, so per-user pools can use them when `db2i` is undefined.
   * Undefined if the env var is unset or has no options.
   */
  get db2iJdbcOptions(): JDBCOptions | undefined {
    const rawJdbcOptions = process.env.DB2i_JDBC_OPTIONS;
    return rawJdbcOptions ? parseJdbcOptionsString(rawJdbcOptions) : undefined;
  },

  /**
   * IBM i DB2 configuration. Undefined if no related env vars are set.
   *
   * Implemented as a getter so the CLI can set DB2i_* env vars at runtime
   * (via connectSystem) after the config module has already been imported
   * through the static import chain (logger → utils → config).
   */
  get db2i():
    | {
        host: string;
        port: number;
        user: string;
        password: string;
        ignoreUnauthorized: boolean;
        jdbcOptions?: JDBCOptions;
      }
    | undefined {
    const host = process.env.DB2i_HOST;
    const user = process.env.DB2i_USER;
    const password = process.env.DB2i_PASS;
    if (!host || !user || !password) return undefined;
    const ignoreRaw = process.env.DB2i_IGNORE_UNAUTHORIZED ?? "true";
    const jdbcOptions = this.db2iJdbcOptions;
    return {
      host,
      port: Db2iPortSchema.parse(process.env.DB2i_PORT),
      user,
      password,
      ignoreUnauthorized: ignoreRaw === "true" || ignoreRaw === "1",
      ...(jdbcOptions ? { jdbcOptions } : {}),
    };
  },

  /** Path to YAML tools configuration file. From `TOOLS_YAML_PATH`. */
  toolsYamlPath: env.TOOLS_YAML_PATH,

  /** YAML configuration merge options. From `YAML_MERGE_*` environment variables. */
  yamlMergeOptions: {
    mergeArrays: env.YAML_MERGE_ARRAYS,
    allowDuplicateTools: env.YAML_ALLOW_DUPLICATE_TOOLS,
    allowDuplicateSources: env.YAML_ALLOW_DUPLICATE_SOURCES,
    validateMerged: env.YAML_VALIDATE_MERGED,
  },

  /**
   * IBM i HTTP token authentication. From `IBMI_HTTP_AUTH_ENABLED` and the
   * `IBMI_AUTH_*` environment variables.
   * @deprecated IBM i HTTP token authentication will be removed in a future
   * major release. Use `MCP_AUTH_MODE=oauth`.
   */
  ibmiHttpAuth: {
    enabled: env.IBMI_HTTP_AUTH_ENABLED,
    allowHttp: env.IBMI_AUTH_ALLOW_HTTP,
    tokenExpirySeconds: env.IBMI_AUTH_TOKEN_EXPIRY_SECONDS,
    cleanupIntervalSeconds: env.IBMI_AUTH_CLEANUP_INTERVAL_SECONDS,
    maxConcurrentSessions: env.IBMI_AUTH_MAX_CONCURRENT_SESSIONS,
    privateKeyPath: env.IBMI_AUTH_PRIVATE_KEY_PATH,
    publicKeyPath: env.IBMI_AUTH_PUBLIC_KEY_PATH,
    keyId: env.IBMI_AUTH_KEY_ID,
    /** Lower-case host names `/api/v1/auth` may sign on to. */
    allowedHosts: (env.IBMI_AUTH_ALLOWED_HOSTS || env.DB2i_HOST || "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  },

  /** Enable automatic reloading of YAML tools when configuration files change. From `YAML_AUTO_RELOAD`. Default: true. */
  yamlAutoReload: env.YAML_AUTO_RELOAD,

  /** Selected toolsets for filtering tools. Set via CLI --toolsets option or SELECTED_TOOLSETS environment variable. */
  selectedToolsets: env.SELECTED_TOOLSETS?.split(",")
    .map((ts) => ts.trim())
    .filter(Boolean) as string[] | undefined,
  ibmi_enableExecuteSql: env.IBMI_ENABLE_EXECUTE_SQL,
  ibmi_executeSqlReadonly: env.IBMI_EXECUTE_SQL_READONLY,
  ibmi_enableDefaultTools: env.IBMI_ENABLE_DEFAULT_TOOLS,

  /** Rate limiting configuration for HTTP transport. From `MCP_RATE_LIMIT_*` environment variables. */
  rateLimit: {
    enabled: env.MCP_RATE_LIMIT_ENABLED,
    maxRequests: env.MCP_RATE_LIMIT_MAX_REQUESTS,
    windowMs: env.MCP_RATE_LIMIT_WINDOW_MS,
    skipInDevelopment: env.MCP_RATE_LIMIT_SKIP_DEV,
  },

  /** Connection pool timeout configuration. From `MCP_POOL_*` environment variables. */
  poolTimeouts: {
    idleTimeoutMs: env.MCP_POOL_IDLE_TIMEOUT_MS,
    queryTimeoutMs: env.MCP_POOL_QUERY_TIMEOUT_MS,
  },

  /** Pagination configuration for SQL tool fetches. From `IBMI_PAGINATION_*` environment variables. */
  pagination: {
    defaultPageSize: env.IBMI_PAGINATION_DEFAULT_PAGE_SIZE,
    maxRows: env.IBMI_PAGINATION_MAX_ROWS,
  },
};

if (config.ibmiHttpAuth.enabled) {
  const missing: string[] = [];
  if (!config.ibmiHttpAuth.privateKeyPath) {
    missing.push("IBMI_AUTH_PRIVATE_KEY_PATH");
  }
  if (!config.ibmiHttpAuth.publicKeyPath) {
    missing.push("IBMI_AUTH_PUBLIC_KEY_PATH");
  }
  if (!config.ibmiHttpAuth.keyId) {
    missing.push("IBMI_AUTH_KEY_ID");
  }

  if (missing.length > 0) {
    throw new Error(
      `IBM i HTTP auth is enabled but missing required key configuration: ${missing.join(", ")}`,
    );
  }
}

export const environment: string = config.environment;

/**
 * Default number of rows fetched per `fetchMore` call when a tool paginates
 * without specifying its own page size. Sourced from
 * `IBMI_PAGINATION_DEFAULT_PAGE_SIZE` (default 1000).
 */
export const DEFAULT_PAGE_SIZE: number = config.pagination.defaultPageSize;

/**
 * Upper bound on total rows returned by a single paginated tool call. The
 * pagination loop terminates once accumulated rows reach this value and
 * flags the result as truncated. Sourced from `IBMI_PAGINATION_MAX_ROWS`
 * (default 30000).
 */
export const MAX_PAGINATION_ROWS: number = config.pagination.maxRows;
