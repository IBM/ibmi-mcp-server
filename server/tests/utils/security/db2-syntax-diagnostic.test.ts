import { describe, it } from "vitest";
import pkg from "node-sql-parser";
const { Parser } = pkg;

describe("DB2 Syntax Parsing Diagnostic", () => {
  const parser = new Parser();

  it("Test 1: Simple SELECT", () => {
    const query = "SELECT * FROM users";
    try {
      const ast = parser.astify(query, { database: "db2" });
      console.log("✓ Simple SELECT works");
      console.log("AST:", JSON.stringify(ast, null, 2).substring(0, 200));
    } catch (error) {
      console.log("✗ Simple SELECT failed:", error);
      throw error;
    }
  });

  it("Test 2: WITH CTE", () => {
    const query = `WITH temp AS (SELECT id FROM users) SELECT * FROM temp`;
    try {
      const ast = parser.astify(query, { database: "db2" });
      console.log("✓ CTE works");
    } catch (error) {
      console.log("✗ CTE failed:", error);
      throw error;
    }
  });

  it("Test 3: CONCAT function", () => {
    const query = "SELECT CONCAT('a', 'b') FROM users";
    try {
      const ast = parser.astify(query, { database: "db2" });
      console.log("✓ CONCAT function works");
    } catch (error) {
      console.log("✗ CONCAT function failed:", error);
      throw error;
    }
  });

  it("Test 4: CONCAT operator (DB2 infix)", () => {
    const query = "SELECT 'a' CONCAT 'b' FROM users";
    try {
      const ast = parser.astify(query, { database: "db2" });
      console.log("✓ CONCAT operator works");
    } catch (error) {
      console.log("✗ CONCAT operator failed:", error instanceof Error ? error.message : error);
      throw error;
    }
  });

  it("Test 5: Parameter with colon prefix", () => {
    const query = "SELECT * FROM users WHERE id = :user_id";
    try {
      const ast = parser.astify(query, { database: "db2" });
      console.log("✓ Colon parameter works");
    } catch (error) {
      console.log("✗ Colon parameter failed:", error instanceof Error ? error.message : error);
      throw error;
    }
  });

  it("Test 6: FETCH FIRST clause", () => {
    const query = "SELECT * FROM users FETCH FIRST 10 ROWS ONLY";
    try {
      const ast = parser.astify(query, { database: "db2" });
      console.log("✓ FETCH FIRST works");
    } catch (error) {
      console.log("✗ FETCH FIRST failed:", error instanceof Error ? error.message : error);
      throw error;
    }
  });

  it("Test 7: CTE with column list", () => {
    const query = `WITH iLevel(iVersion, iRelease) AS (SELECT v, r FROM sys) SELECT * FROM iLevel`;
    try {
      const ast = parser.astify(query, { database: "db2" });
      console.log("✓ CTE with column list works");
    } catch (error) {
      console.log("✗ CTE with column list failed:", error instanceof Error ? error.message : error);
      throw error;
    }
  });
});
