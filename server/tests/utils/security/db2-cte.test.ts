import { describe, it, expect } from "vitest";
import { SqlSecurityValidator } from "../../../src/ibmi-mcp-server/utils/security/sqlSecurityValidator.js";
import { createRequestContext } from "../../../src/utils/internal/requestContext.js";

describe("DB2 CTE Query Parsing Test", () => {
  const context = createRequestContext();
  const readOnlyConfig = { readOnly: true };

  it("ORIGINAL: should FAIL with CONCAT operator (DB2 infix syntax)", () => {
    // This uses DB2-specific CONCAT operator syntax: 'R' CONCAT iVersion
    // The parser doesn't support this and will fail-closed
    const query = `WITH iLevel(iVersion, iRelease) AS (
        SELECT OS_VERSION, OS_RELEASE
        FROM SYSIBMADM.ENV_SYS_INFO
      )
      SELECT P.PTF_GROUP_ID,
             P.PTF_GROUP_TITLE,
             P.PTF_GROUP_LEVEL_INSTALLED,
             P.PTF_GROUP_LEVEL_AVAILABLE,
             (P.PTF_GROUP_LEVEL_AVAILABLE - P.PTF_GROUP_LEVEL_INSTALLED) AS LEVELS_BEHIND,
             P.LAST_UPDATED_BY_IBM,
             P.PTF_GROUP_STATUS_ON_SYSTEM
      FROM iLevel, SYSTOOLS.GROUP_PTF_CURRENCY P
      WHERE PTF_GROUP_RELEASE = 'R' CONCAT iVersion CONCAT iRelease CONCAT '0'
        AND P.PTF_GROUP_CURRENCY = 'UPDATE AVAILABLE'
        AND (P.PTF_GROUP_LEVEL_AVAILABLE - P.PTF_GROUP_LEVEL_INSTALLED) >= 1
      ORDER BY PTF_GROUP_LEVEL_AVAILABLE - PTF_GROUP_LEVEL_INSTALLED DESC
      FETCH FIRST 50 ROWS ONLY`;

    console.log("\n[ORIGINAL] Testing DB2 CONCAT operator syntax...");

    // This should fail because parser can't handle CONCAT operator
    expect(() =>
      SqlSecurityValidator.validateQuery(query, readOnlyConfig, context),
    ).toThrow();

    console.log("✓ Expected: Query REJECTED due to unsupported CONCAT operator syntax");
  });

  it("REWRITTEN: should PASS with CONCAT() function", () => {
    // Rewritten to use CONCAT() as a function instead of operator
    // Changed: 'R' CONCAT iVersion CONCAT iRelease CONCAT '0'
    // To: CONCAT(CONCAT(CONCAT('R', iVersion), iRelease), '0')
    // Also removed :parameter syntax (replaced with literal)
    const query = `WITH iLevel(iVersion, iRelease) AS (
        SELECT OS_VERSION, OS_RELEASE
        FROM SYSIBMADM.ENV_SYS_INFO
      )
      SELECT P.PTF_GROUP_ID,
             P.PTF_GROUP_TITLE,
             P.PTF_GROUP_LEVEL_INSTALLED,
             P.PTF_GROUP_LEVEL_AVAILABLE,
             (P.PTF_GROUP_LEVEL_AVAILABLE - P.PTF_GROUP_LEVEL_INSTALLED) AS LEVELS_BEHIND,
             P.LAST_UPDATED_BY_IBM,
             P.PTF_GROUP_STATUS_ON_SYSTEM
      FROM iLevel, SYSTOOLS.GROUP_PTF_CURRENCY P
      WHERE PTF_GROUP_RELEASE = CONCAT(CONCAT(CONCAT('R', iVersion), iRelease), '0')
        AND P.PTF_GROUP_CURRENCY = 'UPDATE AVAILABLE'
        AND (P.PTF_GROUP_LEVEL_AVAILABLE - P.PTF_GROUP_LEVEL_INSTALLED) >= 1
      ORDER BY PTF_GROUP_LEVEL_AVAILABLE - PTF_GROUP_LEVEL_INSTALLED DESC
      FETCH FIRST 50 ROWS ONLY`;

    console.log("\n[REWRITTEN] Testing with CONCAT() function syntax...");

    try {
      SqlSecurityValidator.validateQuery(query, readOnlyConfig, context);
      console.log("✓ Query validation PASSED - Parser accepts CONCAT() function");
    } catch (error) {
      console.log("✗ Query validation FAILED");
      if (error instanceof Error) {
        console.log("Error message:", error.message);
      }
      throw error;
    }
  });
});
