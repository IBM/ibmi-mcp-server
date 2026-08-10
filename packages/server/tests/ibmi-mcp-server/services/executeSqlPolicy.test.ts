/**
 * Tests for the effective read-only policy shared between the execute_sql
 * tool config and the singleton pool's JDBC access backstop.
 *
 * The pool resolves its `access` backstop from this policy at lazy init, so
 * runtime configuration (CLI `--no-read-only` via configureExecuteSqlTool,
 * `ibmi tool` via setExecuteSqlReadOnlyPolicy) must be reflected here — not
 * just the IBMI_EXECUTE_SQL_READONLY env var.
 *
 * @module tests/ibmi-mcp-server/services/executeSqlPolicy.test
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  setExecuteSqlReadOnlyPolicy,
  isExecuteSqlReadOnlyPolicy,
} from "../../../src/ibmi-mcp-server/services/executeSqlPolicy.js";
import { configureExecuteSqlTool } from "../../../src/ibmi-mcp-server/tools/executeSql.tool.js";
import { config } from "../../../src/config/index.js";

describe("executeSqlPolicy – effective read-only policy for the singleton pool", () => {
  afterEach(() => {
    // Restore the env-derived default so other test files see pristine state.
    configureExecuteSqlTool({
      security: { readOnly: config.ibmi_executeSqlReadonly },
    });
  });

  it("configureExecuteSqlTool({readOnly:false}) flips the pool policy (CLI --no-read-only path)", () => {
    configureExecuteSqlTool({ security: { readOnly: false } });
    expect(isExecuteSqlReadOnlyPolicy()).toBe(false);
  });

  it("configureExecuteSqlTool({readOnly:true}) restores the read-only policy", () => {
    configureExecuteSqlTool({ security: { readOnly: false } });
    configureExecuteSqlTool({ security: { readOnly: true } });
    expect(isExecuteSqlReadOnlyPolicy()).toBe(true);
  });

  it("unrelated configure calls leave the policy at the current readOnly value", () => {
    configureExecuteSqlTool({ security: { readOnly: true } });
    configureExecuteSqlTool({ enabled: true });
    expect(isExecuteSqlReadOnlyPolicy()).toBe(true);
  });

  it("setExecuteSqlReadOnlyPolicy is honored directly (ibmi tool path)", () => {
    setExecuteSqlReadOnlyPolicy(false);
    expect(isExecuteSqlReadOnlyPolicy()).toBe(false);
    setExecuteSqlReadOnlyPolicy(true);
    expect(isExecuteSqlReadOnlyPolicy()).toBe(true);
  });
});
