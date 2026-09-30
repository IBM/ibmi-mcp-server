/**
 * @fileoverview Offline safety invariant for the execute_sql quick path,
 * checked against a Db2-labelled corpus (fixtures/executeSqlCorpus.json:
 * attack, fuzz and benign statements with the live QSYS2.PARSE_STATEMENT rows
 * from IBM i 7.4).
 *
 * Invariant: a quick-path mistake may only cost latency, never safety.
 * - If the quick path approves a statement in a mode, the slow-path rules
 *   applied to Db2's rows also allow it in that mode.
 * - Attack and fuzz statements for which Db2 returned no rows (JDBC escapes,
 *   U& names, syntax errors, multiple statements) are never quick-approved.
 *   Benign rows are exempt: the quick path does not check syntax and approves
 *   plain queries such as `VALUES 1` that PARSE_STATEMENT returns no rows for.
 *   That costs no safety because Db2 does not run text it cannot parse.
 * Rows labelled with NAMING *SYS carry `naming`; the quick path is
 * naming-agnostic, so the offline check does not need it.
 * - A quick-path rejection is never stricter than the slow path.
 */

import { describe, expect, it } from "vitest";
import corpus from "./fixtures/executeSqlCorpus.json";
import {
  evaluateParseStatementRows,
  quickPath,
} from "../../../../src/ibmi-mcp-server/utils/security/executeSqlGuardrail.js";

const MODES = ["read", "read-call"] as const;
const PATTERN_SETS = {
  default: ["QCMDEXC"],
  wildcards: ["QCMDEXC", "HTTP*", "SYSTOOLS.*", "*EMAIL", "QSYS2.MQ*"],
};

describe("execute_sql quick path safety invariant (Db2-labelled corpus)", () => {
  it("covers attack, fuzz and benign statements", () => {
    const sets = new Set(corpus.rows.map((r) => r.set));
    expect([...sets].sort()).toEqual(["attack", "benign", "fuzz"]);
    expect(corpus.rows.length).toBeGreaterThan(600);
  });

  for (const [name, patterns] of Object.entries(PATTERN_SETS)) {
    for (const mode of MODES) {
      it(`${mode} with ${name} forbidden functions`, () => {
        const violations: string[] = [];
        for (const { id, set, sql, db2Rows } of corpus.rows) {
          const quick = quickPath(sql, mode, patterns);
          const slow = evaluateParseStatementRows(db2Rows, mode, patterns);
          if (quick.verdict === "approve") {
            if (db2Rows.length === 0 && set !== "benign") {
              violations.push(`${id}: approved, Db2 returned no rows`);
            } else if (db2Rows.length > 0 && slow) {
              violations.push(`${id}: approved, slow path says ${slow.rule}`);
            }
          }
          if (quick.verdict === "reject" && !slow) {
            violations.push(`${id}: rejected, slow path allows`);
          }
        }
        expect(violations).toEqual([]);
      });
    }
  }
});
