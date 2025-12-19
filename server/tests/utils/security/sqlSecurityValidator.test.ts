import { describe, it, expect } from "vitest";
import { SqlSecurityValidator } from "../../../src/ibmi-mcp-server/utils/security/sqlSecurityValidator.js";
import { McpError, JsonRpcErrorCode } from "../../../src/types-global/errors.js";
import { createRequestContext } from "../../../src/utils/internal/requestContext.js";

describe("SqlSecurityValidator", () => {
  const context = createRequestContext();

  describe("Query Length Validation", () => {
    it("should allow queries under max length", () => {
      const config = { readOnly: false, maxQueryLength: 100 };
      const query = "SELECT * FROM users";

      expect(() =>
        SqlSecurityValidator.validateQuery(query, config, context),
      ).not.toThrow();
    });

    it("should reject queries exceeding max length", () => {
      const config = { readOnly: false, maxQueryLength: 10 };
      const query = "SELECT * FROM users WHERE id = 1";

      expect(() =>
        SqlSecurityValidator.validateQuery(query, config, context),
      ).toThrow(McpError);

      try {
        SqlSecurityValidator.validateQuery(query, config, context);
      } catch (error) {
        if (error instanceof McpError) {
          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.message).toContain("exceeds maximum length");
        }
      }
    });
  });

  describe("Read-Only Mode - Allowed Queries", () => {
    const readOnlyConfig = { readOnly: true };

    it("should allow simple SELECT", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT * FROM users",
          readOnlyConfig,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow SELECT with string literal containing dangerous keyword", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT 'DROP TABLE X' AS txt",
          readOnlyConfig,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow SELECT with CONCAT function (no longer dangerous)", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT CONCAT('a', 'b') AS result",
          readOnlyConfig,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow SELECT with CHAR/VARCHAR functions", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT CHAR(65) AS letter",
          readOnlyConfig,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow SELECT with JOIN", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT u.*, o.* FROM users u JOIN orders o ON u.id = o.user_id",
          readOnlyConfig,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow SELECT with subquery", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)",
          readOnlyConfig,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow SELECT with CTE", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "WITH active_users AS (SELECT * FROM users WHERE active = 1) SELECT * FROM active_users",
          readOnlyConfig,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow UNION of SELECTs", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT id FROM users UNION SELECT id FROM customers",
          readOnlyConfig,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow SELECT with WHERE clause", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT * FROM users WHERE active = 1 AND role = 'admin'",
          readOnlyConfig,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow SELECT with GROUP BY and HAVING", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT department, COUNT(*) FROM employees GROUP BY department HAVING COUNT(*) > 5",
          readOnlyConfig,
          context,
        ),
      ).not.toThrow();
    });
  });

  describe("Read-Only Mode - Rejected Queries (Write Operations)", () => {
    const readOnlyConfig = { readOnly: true };

    it("should reject INSERT", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "INSERT INTO users (name) VALUES ('test')",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);

      try {
        SqlSecurityValidator.validateQuery(
          "INSERT INTO users (name) VALUES ('test')",
          readOnlyConfig,
          context,
        );
      } catch (error) {
        if (error instanceof McpError) {
          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.message).toContain("Write operations detected");
        }
      }
    });

    it("should reject UPDATE", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "UPDATE users SET name = 'test' WHERE id = 1",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject DELETE", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "DELETE FROM users WHERE id = 1",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject DROP TABLE", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "DROP TABLE users",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject CREATE TABLE", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "CREATE TABLE test (id INT)",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject ALTER TABLE", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "ALTER TABLE users ADD COLUMN email VARCHAR(255)",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject TRUNCATE", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "TRUNCATE TABLE users",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject MERGE", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "MERGE INTO target USING source ON target.id = source.id",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject REPLACE", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "REPLACE INTO users (id, name) VALUES (1, 'test')",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject GRANT", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "GRANT SELECT ON users TO public",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject REVOKE", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "REVOKE SELECT ON users FROM public",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject CALL stored procedure", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "CALL sp_update_users()",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });
  });

  describe("Read-Only Mode - Multi-Statement Queries", () => {
    const readOnlyConfig = { readOnly: true };

    it("should allow multiple SELECTs", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT * FROM users; SELECT * FROM orders",
          readOnlyConfig,
          context,
        ),
      ).not.toThrow();
    });

    it("should reject SELECT followed by DELETE", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT * FROM users; DELETE FROM users WHERE id = 1",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject DELETE followed by SELECT", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "DELETE FROM users WHERE id = 1; SELECT * FROM users",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject INSERT followed by SELECT", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "INSERT INTO users (name) VALUES ('test'); SELECT * FROM users",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });
  });

  describe("Read-Only Mode - Parsing Failures (Fail-Closed)", () => {
    const readOnlyConfig = { readOnly: true };

    it("should reject invalid SQL syntax", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT * FROM WHERE",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);

      try {
        SqlSecurityValidator.validateQuery(
          "SELECT * FROM WHERE",
          readOnlyConfig,
          context,
        );
      } catch (error) {
        if (error instanceof McpError) {
          expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
          expect(error.message).toContain("Write operations detected");
          expect(error.details?.violations).toBeDefined();
          expect(error.details?.violations).toContain(
            "SQL parsing failed (cannot validate read-only safely)",
          );
        }
      }
    });

    it("should reject unparseable SQL", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "COMPLETELY INVALID SQL@#$%",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject malformed query with unmatched parentheses", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT * FROM users WHERE id IN (1, 2, 3",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });
  });

  describe("Read-Only Mode - Dangerous Functions", () => {
    const readOnlyConfig = { readOnly: true };

    it("should reject QCMDEXC function", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT QCMDEXC('DLTLIB MYLIB') FROM SYSIBM.SYSDUMMY1",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);

      try {
        SqlSecurityValidator.validateQuery(
          "SELECT QCMDEXC('DLTLIB MYLIB') FROM SYSIBM.SYSDUMMY1",
          readOnlyConfig,
          context,
        );
      } catch (error) {
        if (error instanceof McpError) {
          expect(error.message).toContain("QCMDEXC");
        }
      }
    });

    it("should reject SYSTEM function", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT SYSTEM('rm -rf /') FROM SYSIBM.SYSDUMMY1",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject SQL_EXECUTE_IMMEDIATE function", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT SQL_EXECUTE_IMMEDIATE('DROP TABLE users')",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });

    it("should reject EXEC function", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT EXEC('malicious_command')",
          readOnlyConfig,
          context,
        ),
      ).toThrow(McpError);
    });
  });

  describe("Forbidden Keywords Validation", () => {
    it("should reject forbidden keyword in actual SQL", () => {
      const config = { readOnly: false, forbiddenKeywords: ["DROP"] };

      expect(() =>
        SqlSecurityValidator.validateQuery("DROP TABLE users", config, context),
      ).toThrow(McpError);

      try {
        SqlSecurityValidator.validateQuery("DROP TABLE users", config, context);
      } catch (error) {
        if (error instanceof McpError) {
          expect(error.message).toContain("Forbidden keyword");
          expect(error.message).toContain("DROP");
        }
      }
    });

    it("should allow forbidden keyword in string literal", () => {
      const config = { readOnly: false, forbiddenKeywords: ["DROP"] };

      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT 'DROP' AS action",
          config,
          context,
        ),
      ).not.toThrow();
    });

    it("should reject multiple forbidden keywords", () => {
      const config = {
        readOnly: false,
        forbiddenKeywords: ["DROP", "DELETE", "TRUNCATE"],
      };

      expect(() =>
        SqlSecurityValidator.validateQuery("DROP TABLE users", config, context),
      ).toThrow(McpError);

      expect(() =>
        SqlSecurityValidator.validateQuery(
          "DELETE FROM users",
          config,
          context,
        ),
      ).toThrow(McpError);

      expect(() =>
        SqlSecurityValidator.validateQuery(
          "TRUNCATE TABLE users",
          config,
          context,
        ),
      ).toThrow(McpError);
    });
  });

  describe("Non-Read-Only Mode", () => {
    const config = { readOnly: false };

    it("should allow INSERT when readOnly is false", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "INSERT INTO users (name) VALUES ('test')",
          config,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow UPDATE when readOnly is false", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "UPDATE users SET name = 'test'",
          config,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow DELETE when readOnly is false", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "DELETE FROM users",
          config,
          context,
        ),
      ).not.toThrow();
    });

    it("should allow DROP when readOnly is false", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery("DROP TABLE users", config, context),
      ).not.toThrow();
    });

    it("should allow CREATE when readOnly is false", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "CREATE TABLE test (id INT)",
          config,
          context,
        ),
      ).not.toThrow();
    });
  });

  describe("Edge Cases", () => {
    it("should allow empty query (parser may treat as valid)", () => {
      const config = { readOnly: true };

      // Empty queries may parse successfully depending on parser behavior
      // Not a security risk as they execute as no-op
      expect(() =>
        SqlSecurityValidator.validateQuery("", config, context),
      ).not.toThrow();
    });

    it("should allow whitespace-only query (parser may treat as valid)", () => {
      const config = { readOnly: true };

      // Whitespace queries may parse successfully depending on parser behavior
      // Not a security risk as they execute as no-op
      expect(() =>
        SqlSecurityValidator.validateQuery("   \n\t  ", config, context),
      ).not.toThrow();
    });

    it("should handle case variations", () => {
      const config = { readOnly: true };

      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SeLeCt * FrOm users",
          config,
          context,
        ),
      ).not.toThrow();
    });

    it("should handle query with multiple spaces", () => {
      const config = { readOnly: true };

      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT    *    FROM    users",
          config,
          context,
        ),
      ).not.toThrow();
    });

    it("should handle query with tabs and newlines", () => {
      const config = { readOnly: true };

      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT\t*\nFROM\tusers\nWHERE\tid\t=\t1",
          config,
          context,
        ),
      ).not.toThrow();
    });
  });

  describe("SQL Normalization Edge Cases", () => {
    const config = { readOnly: false, forbiddenKeywords: ["UPDATE"] };

    it("should handle escaped quotes in string literals", () => {
      expect(() =>
        SqlSecurityValidator.validateQuery(
          "SELECT 'can''t UPDATE this' AS message",
          config,
          context,
        ),
      ).not.toThrow();
    });
  });
});
