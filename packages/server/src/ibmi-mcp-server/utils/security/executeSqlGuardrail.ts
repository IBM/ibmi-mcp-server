/**
 * @fileoverview The execute_sql guardrails: the single check every execute_sql
 * surface (the MCP tool, `ibmi sql` single- and multi-system) runs before a
 * statement is sent to IBM i.
 *
 * The guardrails constrain the SQL text an agent can send. They are not a
 * security boundary: the IBM i user profile's authority decides what a
 * statement can actually do (user-defined routines, views, triggers and
 * procedure bodies are invisible here).
 *
 * Order of checks:
 *   1. length limit and forbidden keywords (every mode, including write)
 *   2. write: done
 *   3. quick path: the in-process Db2 for i parser approves statements it is
 *      certain about, rejects obvious non-query statements, and sends
 *      everything else to
 *   4. slow path: one QSYS2.PARSE_STATEMENT call (it parses, never executes)
 *      whose rows decide.
 *
 * A quick-path mistake may only cost latency, never safety: it approves only
 * what the slow-path rules would also allow (a committed Db2-labelled corpus
 * test checks this).
 *
 * @module src/ibmi-mcp-server/utils/security/executeSqlGuardrail
 */

import type { BindingValue, JDBCOptions } from "@ibm/mapepire-js";
import { config } from "@/config/index.js";
import { logger } from "@/utils/internal/logger.js";
import type { RequestContext } from "@/utils/internal/requestContext.js";
import { JsonRpcErrorCode, McpError } from "@/types-global/errors.js";
import Document from "@/ibmi-mcp-server/utils/language/document.js";
import SQLTokeniser from "@/ibmi-mcp-server/utils/language/tokens.js";
import type { Token } from "@/ibmi-mcp-server/utils/language/types.js";
import type { ExecuteSqlAccess } from "@/ibmi-mcp-server/services/executeSqlAccess.js";

// =============================================================================
// Rule constants (the one place the modes are defined)
// =============================================================================

type GuardedMode = Exclude<ExecuteSqlAccess, "write">;

interface ModeRules {
  /** PARSE_STATEMENT SQL_STATEMENT_TYPE values the mode allows. */
  statementTypes: ReadonlySet<string>;
  /** Leading keywords the quick path may approve (the same statement types). */
  leadingWords: ReadonlySet<string>;
  /** Sequence references (NEXT VALUE / PREVIOUS VALUE) allowed. */
  sequences: boolean;
  /** Forbidden-function gate applies. */
  forbiddenFunctions: boolean;
}

const MODE_RULES: Record<GuardedMode, ModeRules> = {
  read: {
    statementTypes: new Set(["QUERY"]),
    leadingWords: new Set(["SELECT", "WITH", "VALUES"]),
    sequences: false,
    forbiddenFunctions: true,
  },
  "read-call": {
    statementTypes: new Set(["QUERY", "CALL"]),
    leadingWords: new Set(["SELECT", "WITH", "VALUES", "CALL"]),
    sequences: true,
    forbiddenFunctions: false,
  },
};

/**
 * Leading keywords of statements that are never a query or CALL. The quick
 * path rejects these directly instead of asking PARSE_STATEMENT.
 */
const NON_QUERY_LEADING_WORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "TRUNCATE",
  "CREATE",
  "ALTER",
  "DROP",
  "RENAME",
  "GRANT",
  "REVOKE",
  "DECLARE",
  "SET",
  "COMMIT",
  "ROLLBACK",
  "LOCK",
  "REFRESH",
]);

/**
 * Tokens that send a query to the slow path in read and read-call: a
 * data-change verb (also inside FINAL/NEW/OLD TABLE (...)) or SELECT/VALUES
 * INTO. A trigger never rejects by itself.
 */
const DATA_CHANGE_TRIGGERS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "INTO",
]);
const DATA_CHANGE_TABLE_PREFIXES = new Set(["FINAL", "NEW", "OLD"]);

/** USAGE_TYPE allowed in read-call only for the called procedure itself. */
const CALL_TARGET_USAGE = "TARGET PROCEDURE";

const DEFAULT_MAX_QUERY_LENGTH = 10000;

/** Guardrail rule identifiers (McpError `details.rule`). */
export type GuardrailRule =
  | "max-length"
  | "forbidden-keyword"
  | "statement-type"
  | "write-usage"
  | "sequence"
  | "forbidden-function"
  | "unverifiable";

/** A guardrail rejection, before it becomes an McpError. */
export interface GuardrailRejection {
  rule: GuardrailRule;
  /** What the guardrail saw, e.g. "statement type INSERT is not allowed". */
  reason: string;
  /** The offending token, name or statement type. */
  offending: string;
  /** Lowest mode whose guardrails allow it; undefined = no mode does. */
  lowestMode?: ExecuteSqlAccess;
}

// =============================================================================
// Public types
// =============================================================================

/**
 * Runs a query on the connection the statement would run on, fetching up to
 * `rowsToFetch` rows. The CLI multi-system path passes one per target system.
 * `is_done` must be true: an incomplete result is rejected.
 */
export type ParseStatementExecutor = (
  query: string,
  params: BindingValue[],
  rowsToFetch: number,
) => Promise<{ data?: readonly unknown[]; is_done?: boolean }>;

export interface ExecuteSqlGuardrailOptions {
  /** Guardrail mode in effect. */
  access: ExecuteSqlAccess;
  /** Runs the slow-path PARSE_STATEMENT query. */
  parseStatement: ParseStatementExecutor;
  /**
   * Connection JDBC options, to match PARSE_STATEMENT naming and decimal
   * point. Defaults to DB2i_JDBC_OPTIONS (what the singleton pool and
   * SourceManager apply).
   */
  jdbcOptions?: JDBCOptions;
  /**
   * Keyword patterns added to IBMI_EXECUTE_SQL_FORBIDDEN_KEYWORDS (e.g. the
   * CLI's per-system `forbiddenKeywords`).
   */
  forbiddenKeywords?: readonly string[];
  /** Function patterns; defaults to IBMI_EXECUTE_SQL_FORBIDDEN_FUNCTIONS. */
  forbiddenFunctions?: readonly string[];
  /** Default 10000. */
  maxQueryLength?: number;
}

/** Which check approved the statement. */
export type GuardrailPath = "write" | "quick" | "parse_statement";

// =============================================================================
// Entry point
// =============================================================================

/**
 * Strip trailing statement terminators. Callers validate and execute the
 * returned text: PARSE_STATEMENT returns no rows for a trailing `;`.
 */
export function stripStatementTerminator(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

/**
 * Enforce the execute_sql guardrails on one statement.
 *
 * @param sql - The exact text that will be executed (terminator stripped)
 * @returns The path that approved the statement
 * @throws {McpError} ValidationError naming the mode, rule, offending token
 *   or name, and the lowest mode that would allow it
 */
export async function enforceExecuteSqlGuardrails(
  sql: string,
  options: ExecuteSqlGuardrailOptions,
  context: RequestContext,
): Promise<GuardrailPath> {
  const { access } = options;
  const fail: (rejection: GuardrailRejection, path: GuardrailPath) => never = (
    rejection,
    path,
  ) => throwRejection(sql, access, rejection, path, context);

  const maxLength = options.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH;
  if (sql.length > maxLength) {
    fail(
      {
        rule: "max-length",
        reason: `the statement is ${sql.length} characters; the limit is ${maxLength}`,
        offending: String(sql.length),
      },
      "quick",
    );
  }

  const keywordRejection = checkForbiddenKeywords(sql, [
    ...config.ibmi_executeSqlForbiddenKeywords,
    ...(options.forbiddenKeywords ?? []),
  ]);
  if (keywordRejection) fail(keywordRejection, "quick");

  if (access === "write") return "write";

  const forbiddenFunctions =
    options.forbiddenFunctions ?? config.ibmi_executeSqlForbiddenFunctions;

  const quick = quickPath(sql, access, forbiddenFunctions);
  if (quick.verdict === "approve") {
    logger.debug({ ...context, access }, "execute_sql guardrail: quick path");
    return "quick";
  }
  if (quick.verdict === "reject") fail(quick.rejection, "quick");

  logger.debug(
    { ...context, access, reason: quick.reason },
    "execute_sql guardrail: verifying with QSYS2.PARSE_STATEMENT",
  );
  const result = await options.parseStatement(
    PARSE_STATEMENT_QUERY,
    parseStatementParams(sql, options.jdbcOptions ?? config.db2i?.jdbcOptions),
    PARSE_STATEMENT_MAX_ROWS,
  );
  // A write row can come after any number of QUERY rows: judge all or none
  const rejection =
    result.is_done === true
      ? evaluateParseStatementRows(
          result.data ?? [],
          access,
          forbiddenFunctions,
        )
      : {
          rule: "unverifiable" as const,
          reason: `QSYS2.PARSE_STATEMENT returned more than ${PARSE_STATEMENT_MAX_ROWS} rows`,
          offending: "PARSE_STATEMENT",
          lowestMode: "write" as const,
        };
  if (rejection) fail(rejection, "parse_statement");
  return "parse_statement";
}

function throwRejection(
  sql: string,
  access: ExecuteSqlAccess,
  rejection: GuardrailRejection,
  path: GuardrailPath,
  context: RequestContext,
): never {
  const allows =
    rejection.rule === "unverifiable"
      ? "Only the write guardrail mode skips this check."
      : rejection.lowestMode
        ? `The ${rejection.lowestMode} guardrail mode allows it.`
        : "This applies in every guardrail mode.";
  const message = `execute_sql ${access} guardrail rejected the statement: ${rejection.reason}. ${allows}`;
  const details = {
    access,
    rule: rejection.rule,
    offending: rejection.offending,
    lowestMode: rejection.lowestMode ?? null,
    validatedBy: path,
    query: sql.length > 100 ? `${sql.substring(0, 100)}...` : sql,
  };
  logger.info({ ...context, ...details }, message);
  throw new McpError(JsonRpcErrorCode.ValidationError, message, details);
}

// =============================================================================
// Pattern matching and token helpers
// =============================================================================

function patternRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * A token's name as Db2 would compare it: delimited identifiers lose their
 * quotes and trailing blanks (Db2 ignores trailing blanks in delimited names).
 */
function bareValue(token: Token): string {
  const value = token.value ?? "";
  if (token.type === "sqlName") return value.slice(1, -1).trimEnd();
  return value;
}

/**
 * Name-like candidates in a token list: every non-string token value
 * (split into its name parts) plus each `A.B` / `A/B` qualified pair.
 */
function nameCandidates(tokens: readonly Token[]): string[] {
  const candidates: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === "string") continue;
    const bare = bareValue(token);
    if (token.type === "sqlName") candidates.push(bare);
    // Words the tokenizer did not split (`ORDER BY`, `SALARY!`) yield each
    // name part; ASCII punctuation separates, non-ASCII letters do not
    else {
      candidates.push(
        ...bare.split(/[^A-Za-z0-9_$#@\u0080-\uffff]+/).filter(Boolean),
      );
    }
    const sep = tokens[i + 1];
    const next = tokens[i + 2];
    if (
      (sep?.type === "dot" || sep?.type === "forwardslash") &&
      next &&
      next.type !== "string"
    ) {
      candidates.push(`${bare}.${bareValue(next)}`);
    }
  }
  return candidates;
}

function checkForbiddenKeywords(
  sql: string,
  patterns: readonly string[],
): GuardrailRejection | undefined {
  if (patterns.length === 0) return undefined;
  const regexps = patterns.map((p) => ({ p, re: patternRegExp(p) }));
  // Line breaks only separate words: `QSYS2\n.SYSCOLUMNS` is one name
  const tokens = new SQLTokeniser()
    .tokenise(sql)
    .filter((t) => t.type !== "newline" && t.type !== "newliner");
  for (const candidate of nameCandidates(tokens)) {
    const hit = regexps.find(({ re }) => re.test(candidate));
    if (hit) {
      return {
        rule: "forbidden-keyword",
        reason: `"${candidate}" matches forbidden keyword pattern "${hit.p}"`,
        offending: candidate,
      };
    }
  }
  return undefined;
}

// =============================================================================
// Quick path
// =============================================================================

export type QuickPathResult =
  | { verdict: "approve" }
  | { verdict: "reject"; rejection: GuardrailRejection }
  | { verdict: "slow"; reason: string };

/** Prefixes that join a string literal: X'..', N'..', G'..', GX'..', UX'..', BX'..'. */
const LITERAL_PREFIX = /^(X|N|G|GX|UX|BX)$/i;

/**
 * ASCII punctuation the tokenizer does not split words on (it would glue the
 * neighbouring names into one token).
 */
const UNSPLIT_PUNCTUATION = new Set(["!", "^", "~", "[", "]", "\\", "`"]);

/** The identifier characters immediately before position `end`. */
function wordBefore(sql: string, end: number): string {
  let start = end;
  while (start > 0 && /[A-Za-z0-9_$#@]/.test(sql[start - 1]!)) start--;
  return sql.slice(start, end);
}

/**
 * Why the in-process tokenizer cannot be trusted to split this text the way
 * Db2 does, or undefined. Deliberately narrow: plain ASCII, `--` comments,
 * ordinary strings and simple delimited identifiers only. Anything else
 * (block comments, JDBC `{...}` escapes that jt400 rewrites, `U&` literals,
 * escaped quotes in names, `;`, a word joined to a quote, punctuation the
 * tokenizer does not split on) goes to PARSE_STATEMENT.
 */
function lexicalRisk(sql: string): string | undefined {
  if (/[^\t\n\r\x20-\x7e]/.test(sql)) return "non-ASCII or control character";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const joined = wordBefore(sql, i);
      if (joined && (c === '"' || !LITERAL_PREFIX.test(joined))) {
        return "word joined to a quote";
      }
    }
    if (c === "'") {
      const end = sql.indexOf("'", i + 1);
      if (end < 0) return "unterminated string";
      i = end + 1; // `''` reads as two adjacent strings: same extent
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0) return "unterminated delimited identifier";
      if (!/^[A-Za-z0-9_$#@ ]+$/.test(sql.slice(i + 1, end))) {
        return "delimited identifier with special characters";
      }
      if (sql[end + 1] === '"') return "escaped quote in delimited identifier";
      i = end + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i); // Db2 does not end `--` at CR
      if (end < 0) return undefined;
      i = end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      return "block comment";
    } else if (c === "{" || c === "}") {
      return "JDBC escape";
    } else if (c === "&") {
      return "U& literal";
    } else if (c === ";") {
      return "statement separator";
    } else if (
      UNSPLIT_PUNCTUATION.has(c) &&
      !(c === "!" && sql[i + 1] === "=")
    ) {
      // `!=` only joins `!` to the word before it, which nameCandidates splits off
      return `character ${c}`;
    } else {
      i++;
    }
  }
  return undefined;
}

/**
 * The quick path. Approves only when all hold: the text is lexically plain
 * (see lexicalRisk), it is one statement whose first token is an allowed
 * leading keyword, and no trigger token appears outside strings/comments.
 * Rejects directly a single statement led by a keyword that is never a query
 * or CALL. Everything else goes to the slow path.
 */
export function quickPath(
  sql: string,
  access: GuardedMode,
  forbiddenFunctions: readonly string[],
): QuickPathResult {
  const slow = (reason: string): QuickPathResult => ({
    verdict: "slow",
    reason,
  });

  const risk = lexicalRisk(sql);
  if (risk) return slow(risk);

  let tokens: Token[];
  try {
    const statements = new Document(sql).statements;
    if (statements.length !== 1) return slow("not exactly one statement");
    tokens = statements[0]!.tokens;
  } catch {
    return slow("parser error");
  }

  const rules = MODE_RULES[access];
  // A delimited "SELECT" is a name, not the keyword
  const first = tokens[0]!;
  const leading =
    first.type === "sqlName" ? "" : bareValue(first).toUpperCase();
  if (!rules.leadingWords.has(leading)) {
    if (leading === "CALL") {
      return {
        verdict: "reject",
        rejection: {
          rule: "statement-type",
          reason: "CALL statements are not allowed",
          offending: "CALL",
          lowestMode: "read-call",
        },
      };
    }
    if (NON_QUERY_LEADING_WORDS.has(leading)) {
      return {
        verdict: "reject",
        rejection: {
          rule: "statement-type",
          reason: `${leading} statements are not allowed`,
          offending: leading,
          lowestMode: "write",
        },
      };
    }
    return slow(`leading token ${first.value ?? ""}`);
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === "string") continue;
    const word = bareValue(token).toUpperCase();
    const next = tokens[i + 1] ? bareValue(tokens[i + 1]!).toUpperCase() : "";
    if (DATA_CHANGE_TRIGGERS.has(word)) return slow(`token ${word}`);
    if (DATA_CHANGE_TABLE_PREFIXES.has(word) && next === "TABLE") {
      return slow(`${word} TABLE`);
    }
    if (word === "CALL" && i > 0) return slow("CALL inside a statement");
    if (
      !rules.sequences &&
      (word === "NEXTVAL" ||
        word === "PREVVAL" ||
        (word === "VALUE" && next === "FOR"))
    ) {
      return slow("sequence reference");
    }
  }

  if (rules.forbiddenFunctions && forbiddenFunctions.length > 0) {
    const regexps = forbiddenFunctions.map(patternRegExp);
    const hit = nameCandidates(tokens).find((c) =>
      regexps.some((re) => re.test(c)),
    );
    if (hit) return slow(`possible forbidden function ${hit}`);
  }

  return { verdict: "approve" };
}

// =============================================================================
// Slow path (QSYS2.PARSE_STATEMENT)
// =============================================================================

/**
 * Rows fetched from PARSE_STATEMENT (one per name reference). A result that
 * is not complete within this is rejected.
 */
const PARSE_STATEMENT_MAX_ROWS = 10_000;

const PARSE_STATEMENT_QUERY =
  "SELECT NAME_TYPE, SCHEMA, NAME, USAGE_TYPE, SQL_STATEMENT_TYPE " +
  "FROM TABLE(QSYS2.PARSE_STATEMENT(SQL_STATEMENT => ?, NAMING => ?, " +
  "DECIMAL_POINT => ?, SQL_STRING_DELIMITER => '*APOSTSQL')) P";

/**
 * PARSE_STATEMENT options matching the connection: its own NAMING default is
 * *SYS while a JDBC connection defaults to SQL naming.
 */
export function parseStatementParams(
  sql: string,
  jdbcOptions: JDBCOptions | undefined,
): BindingValue[] {
  return [
    sql,
    jdbcOptions?.naming === "system" ? "*SYS" : "*SQL",
    jdbcOptions?.["decimal separator"] === "," ? "*COMMA" : "*PERIOD",
  ];
}

const text = (value: unknown): string | undefined => {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s === "" ? undefined : s;
};

/**
 * Apply the slow-path rules to PARSE_STATEMENT rows (an allow-list, safe
 * against values it has never seen):
 * - no rows: reject (syntax error, multiple statements or no referenced names)
 *   (the quick path does not check syntax; it approves plain queries such as
 *   `VALUES 1` that PARSE_STATEMENT returns no rows for, and Db2 itself
 *   refuses to run text it cannot parse)
 * - every SQL_STATEMENT_TYPE must be allowed by the mode
 * - USAGE_TYPE must be QUERY, except the called procedure in read-call
 * - read: no SEQUENCE rows (NEXT and PREVIOUS VALUE look identical) and no
 *   FUNCTION row matching a forbidden-function pattern
 *
 * @returns The first rejection, or undefined when the rows are allowed
 */
export function evaluateParseStatementRows(
  rows: readonly unknown[],
  access: GuardedMode,
  forbiddenFunctions: readonly string[],
): GuardrailRejection | undefined {
  if (rows.length === 0) {
    return {
      rule: "unverifiable",
      reason:
        "QSYS2.PARSE_STATEMENT returned no rows, so it could not be verified (a syntax error, more than one statement, or no referenced objects)",
      offending: "PARSE_STATEMENT",
      lowestMode: "write",
    };
  }
  const rules = MODE_RULES[access];
  const parsed = rows.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    return {
      nameType: text(row["NAME_TYPE"])?.toUpperCase() ?? "",
      schema: text(row["SCHEMA"]),
      name: text(row["NAME"]) ?? "",
      usage: text(row["USAGE_TYPE"])?.toUpperCase() ?? "",
      statementType: text(row["SQL_STATEMENT_TYPE"])?.toUpperCase() ?? "",
    };
  });

  for (const row of parsed) {
    if (!rules.statementTypes.has(row.statementType)) {
      const type = row.statementType || "UNKNOWN";
      return {
        rule: "statement-type",
        reason: `statement type ${type} is not allowed`,
        offending: type,
        lowestMode: type === "CALL" ? "read-call" : "write",
      };
    }
  }

  for (const row of parsed) {
    const qualified = row.schema ? `${row.schema}.${row.name}` : row.name;
    const callTarget =
      rules.statementTypes.has("CALL") &&
      row.usage === CALL_TARGET_USAGE &&
      row.nameType === "PROC" &&
      row.statementType === "CALL";
    if (row.usage !== "QUERY" && !callTarget) {
      return {
        rule: "write-usage",
        reason: `${row.nameType || "object"} ${qualified} is used as ${row.usage || "UNKNOWN"} (a data change or definition)`,
        offending: qualified,
        lowestMode: "write",
      };
    }
    if (!rules.sequences && row.nameType === "SEQUENCE") {
      return {
        rule: "sequence",
        reason: `sequence ${qualified} is referenced (NEXT VALUE FOR advances it)`,
        offending: qualified,
        lowestMode: "read-call",
      };
    }
    if (rules.forbiddenFunctions && row.nameType === "FUNCTION") {
      const pattern = forbiddenFunctions.find((p) =>
        functionMatches(p, row.schema, row.name),
      );
      if (pattern) {
        return {
          rule: "forbidden-function",
          reason: `function ${qualified} matches forbidden function pattern "${pattern}" (IBMI_EXECUTE_SQL_FORBIDDEN_FUNCTIONS)`,
          offending: qualified,
          lowestMode: "read-call",
        };
      }
    }
  }
  return undefined;
}

/**
 * A pattern matches a function by NAME or, when the reference is qualified,
 * by SCHEMA.NAME. PARSE_STATEMENT does not resolve unqualified names through
 * the path, so a qualified pattern does not match an unqualified reference.
 */
function functionMatches(
  pattern: string,
  schema: string | undefined,
  name: string,
): boolean {
  const re = patternRegExp(pattern);
  return (
    re.test(name) || (schema !== undefined && re.test(`${schema}.${name}`))
  );
}
