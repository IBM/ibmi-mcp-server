# DB2 CONCAT Operator Parsing Limitation

## Problem

DB2 for i queries using the CONCAT operator (infix notation) are rejected by the SQL security validator with the error:

```
Write operations detected: SQL parsing failed (cannot validate read-only safely)
```

## Root Cause

The `node-sql-parser` library used for AST-based validation does not support DB2's CONCAT operator syntax, even when using the `db2` dialect.

**Unsupported DB2 Syntax:**
```sql
WHERE column = 'R' CONCAT iVersion CONCAT iRelease CONCAT '0'
```

When the parser fails to parse a query in read-only mode, the validator **fails closed** (rejects the query) rather than falling back to regex-only validation. This is a security feature that prevents bypass attacks through unparseable syntax.

## Solution

Rewrite queries to use `CONCAT()` as a **function** instead of an **operator**:

### Before (REJECTED)
```sql
WHERE PTF_GROUP_RELEASE = 'R' CONCAT iVersion CONCAT iRelease CONCAT '0'
```

### After (ACCEPTED)
```sql
WHERE PTF_GROUP_RELEASE = CONCAT(CONCAT(CONCAT('R', iVersion), iRelease), '0')
```

## Example: Complete Query Rewrite

### Original Query (Fails Parsing)
```sql
WITH iLevel(iVersion, iRelease) AS (
  SELECT OS_VERSION, OS_RELEASE
  FROM SYSIBMADM.ENV_SYS_INFO
)
SELECT P.PTF_GROUP_ID,
       P.PTF_GROUP_LEVEL_INSTALLED,
       P.PTF_GROUP_LEVEL_AVAILABLE
FROM iLevel, SYSTOOLS.GROUP_PTF_CURRENCY P
WHERE PTF_GROUP_RELEASE = 'R' CONCAT iVersion CONCAT iRelease CONCAT '0'
  AND P.PTF_GROUP_CURRENCY = 'UPDATE AVAILABLE'
ORDER BY P.PTF_GROUP_LEVEL_AVAILABLE - P.PTF_GROUP_LEVEL_INSTALLED DESC
FETCH FIRST 50 ROWS ONLY
```

### Rewritten Query (Passes Validation)
```sql
WITH iLevel(iVersion, iRelease) AS (
  SELECT OS_VERSION, OS_RELEASE
  FROM SYSIBMADM.ENV_SYS_INFO
)
SELECT P.PTF_GROUP_ID,
       P.PTF_GROUP_LEVEL_INSTALLED,
       P.PTF_GROUP_LEVEL_AVAILABLE
FROM iLevel, SYSTOOLS.GROUP_PTF_CURRENCY P
WHERE PTF_GROUP_RELEASE = CONCAT(CONCAT(CONCAT('R', iVersion), iRelease), '0')
  AND P.PTF_GROUP_CURRENCY = 'UPDATE AVAILABLE'
ORDER BY P.PTF_GROUP_LEVEL_AVAILABLE - P.PTF_GROUP_LEVEL_INSTALLED DESC
FETCH FIRST 50 ROWS ONLY
```

## SQL Security Model

The SQL security validator implements a **defense-in-depth** strategy with multiple validation layers:

### Validation Layers (All Queries)

1. **Query Length Check**
   - Enforces maximum query size (default: 10,000 characters)
   - Prevents resource exhaustion attacks

2. **Forbidden Keywords Validation**
   - User-configurable keyword blocklist
   - Uses AST + normalized regex (string literals stripped)
   - Example: Block `DROP` to prevent accidental table deletion

### Read-Only Mode Validation (When `readOnly !== false`)

3. **AST-Based Allowlist** (Primary Defense)
   - Parses query into Abstract Syntax Tree
   - **Allowlist enforcement**: Only `SELECT` statements permitted
   - Validates nested statements (CTEs, subqueries, unions)
   - Detects dangerous functions: `SYSTEM`, `QCMDEXC`, `SQL_EXECUTE_IMMEDIATE`, `EXEC`
   - **Fail-closed**: Parse failures → query rejection

4. **Normalized Regex Validation** (Secondary Defense)
   - Strips string literals before pattern matching (prevents false positives)
   - Detects dangerous operations: `INSERT`, `UPDATE`, `DELETE`, `DROP`, etc.
   - Catches patterns AST might miss

### Key Security Features

✅ **Fail-Closed Design**: Unparseable queries are rejected (not allowed through)
✅ **Defense in Depth**: Both AST and regex must pass
✅ **False Positive Reduction**: String literals normalized before regex
✅ **No Bypass via Comments**: Comments not allowed in DB2 SQL statements

### What Gets Blocked in Read-Only Mode

- **Write Operations**: INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, MERGE
- **System Commands**: CALL, EXEC, EXECUTE, QCMDEXC, SYSTEM
- **Security Changes**: GRANT, REVOKE, DENY
- **Data Transfer**: LOAD, IMPORT, EXPORT, BULK
- **Unparseable Queries**: Any SQL the parser cannot validate

### What's Allowed in Read-Only Mode

- **SELECT queries**: Including JOINs, WHERE, GROUP BY, ORDER BY
- **CTEs (WITH)**: Common Table Expressions
- **Subqueries**: Nested SELECT statements
- **UNION**: Combining multiple SELECT results
- **Aggregations**: COUNT, SUM, AVG, etc.
- **Standard functions**: CONCAT(), SUBSTRING(), etc.

## Why Fail-Closed?

The security validator uses a **fail-closed** approach in read-only mode:

1. **AST Validation**: Parses query structure to verify only SELECT statements
2. **Parse Failure**: If parsing fails, query is **rejected** (not allowed to fall back to regex)
3. **Security Rationale**: Prevents attackers from using unparseable syntax to bypass AST validation

### Security vs. Compatibility Trade-off

✅ **Security Benefit**: No bypass attacks through unsupported syntax
❌ **Compatibility Impact**: Some valid DB2-specific syntax gets rejected

This is an **intentional security design** - it's better to reject legitimate queries than to risk allowing malicious ones.

## Alternative: Disable Read-Only Mode

If rewriting queries is not feasible, you can disable read-only validation for specific queries by setting:

```javascript
securityConfig.readOnly = false
```

⚠️ **Warning**: This disables security validation and should only be used for trusted queries.

## Other Unsupported DB2 Syntax

The parser may also reject these DB2-specific features:

- `:parameter` syntax (use `?` or literal values instead)
- Some DB2-specific functions
- Complex CTEs with certain column specifications
- Proprietary DB2 operators

When encountering parsing errors, try rewriting using standard SQL syntax that the parser understands.

## Test Coverage

See `tests/utils/security/db2-cte.test.ts` for automated tests demonstrating:
- Original query rejection (expected behavior)
- Rewritten query acceptance (workaround)
