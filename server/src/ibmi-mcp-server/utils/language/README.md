# IBM i SQL Language Utilities

## Attribution

This module is vendored from the official **Code for IBM i** VS Code extension:
- **Project:** [vscode-db2i](https://github.com/codefori/vscode-db2i)

## Purpose

These SQL language utilities provide battle-tested parsing and tokenization for **Db2 for IBM i** SQL syntax. We use them in the IBM i MCP Server for:

### 1. **SQL Security Validation**
The MCP server needs to validate SQL queries for security purposes, especially in read-only mode. The vscode-db2i parser handles IBM i-specific SQL syntax that generic parsers don't support.=

### 2. **Token-Based Validation**
The `SQLTokeniser` class provides precise token-level parsing that distinguishes between:
- SQL keywords vs. identifiers
- String literals vs. SQL code
- Function calls vs. regular identifiers
- Comments vs. executable code

This eliminates false positives when validating forbidden keywords (e.g., detecting `DELETE` as a keyword vs. `'DELETE'` as a string literal).

### 3. **Statement Type Detection**
The `Document` and `Statement` classes provide accurate detection of SQL statement types (SELECT, INSERT, UPDATE, DELETE, CALL, etc.), which is critical for enforcing read-only restrictions.

## Related Projects

- [vscode-db2i](https://github.com/codefori/vscode-db2i) - VS Code extension for Db2 for IBM i
- [Code for IBM i](https://codefori.github.io/) - Development tools for IBM i
- [@ibm/mapepire-js](https://www.npmjs.com/package/@ibm/mapepire-js) - IBM i database driver (used by this MCP server)

---

**Questions or Issues?**
- For SQL parser issues, check [vscode-db2i issues](https://github.com/codefori/vscode-db2i/issues)
- For MCP server issues, check [ibmi-mcp-server issues](https://github.com/IBM/ibmi-mcp-server/issues)
