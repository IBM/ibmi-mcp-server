---
name: ibmi-mcp-tool-builder
description: >-
  Guide and build custom YAML SQL tools for the IBM i MCP Server
  (@ibm/ibmi-mcp-server). Covers designing the tool, discovering the right Db2
  for i SQL services, prototyping and testing the SQL live on IBM i through IBM i
  Developer mode, writing the YAML tool file, validating it against the tool
  JSON schema with the bundled script, and handing the user a command to start
  the MCP server with the new tools. Use when the user wants to create, edit,
  review, test or validate an IBM i MCP SQL tool, a tools YAML file, or a
  toolset.
---

# IBM i MCP Tool Builder

Build YAML-defined SQL tools for the IBM i MCP Server. Every tool is a
parameterized Db2 for i statement plus metadata the LLM sees. The workflow is:
**understand → discover → prototype & test → write YAML → validate → start server**.

Bundled files (paths relative to this skill directory):

| File | Purpose |
|------|---------|
| `scripts/validate-tools.mjs` | Validates YAML tool files against the schema plus binding/reference checks |
| `assets/sql-tools-config.json` | The tool JSON schema (copy of the server's `sql-tools-config.json`) |
| `references/yaml-reference.md` | Field reference, parameter rules, and SQL patterns. Read it before writing YAML |

## 1. Understand the request

Pin down before writing SQL:

- What question should the tool answer, and who calls it (an agent, an ops dashboard)?
- Which inputs the caller should control → parameters. Everything else is fixed in the SQL.
- Read-only or write? Default to read-only. Write tools need explicit user approval (see §3).
- Which file and toolset it belongs to. Ask; default to `tools-tmp/<domain>.yaml`.

If an existing tools YAML file in the workspace already covers the area, extend it instead of creating a new one.

## 2. Discover the right SQL service

Prefer IBM i SQL services (`QSYS2.*`, `SYSTOOLS.*`, `SYSIBMADM.*`) over querying system files directly.
**Never invent tables, columns, or function arguments.** Verify every name on the system.

Switch to **IBM i Developer** mode (Premium Package for i; mode ID `ibm-i-developer`, use
`switch_mode`) to get these tools:

| Tool | Use it for |
|------|-----------|
| `search_sql_examples` | IBM-provided examples for a service, e.g. `QSYS2.ACTIVE_JOB_INFO` |
| `search_ibm_i_docs_with_rag` | Service docs, parameter meanings, release/PTF requirements |
| `get_schema_info` | Resolve a library/schema name (system vs SQL name) |
| `get_file_info` | Object/file metadata |
| `execute_sql_statement` | Run discovery and test queries (§3) |

Useful discovery queries for `execute_sql_statement`:

```sql
-- Find services by keyword
SELECT SERVICE_CATEGORY, SERVICE_SCHEMA_NAME, SERVICE_NAME, SQL_OBJECT_TYPE, EARLIEST_POSSIBLE_RELEASE
  FROM QSYS2.SERVICES_INFO
 WHERE UPPER(SERVICE_NAME) LIKE '%JOB%'
 ORDER BY SERVICE_CATEGORY, SERVICE_NAME;

-- Get IBM's example for a service
SELECT EXAMPLE FROM QSYS2.SERVICES_INFO WHERE SERVICE_NAME = 'ACTIVE_JOB_INFO';

-- Exact column names and types for a table, view, or table function result
SELECT COLUMN_NAME, DATA_TYPE, LENGTH, IS_NULLABLE, COLUMN_TEXT
  FROM QSYS2.SYSCOLUMNS2
 WHERE TABLE_SCHEMA = 'QSYS2' AND TABLE_NAME = 'USER_INFO'
 ORDER BY ORDINAL_POSITION;

-- Table function parameters (names to use with =>)
SELECT PARAMETER_NAME, DATA_TYPE, DEFAULT
  FROM QSYS2.SYSPARMS
 WHERE SPECIFIC_SCHEMA = 'QSYS2' AND SPECIFIC_NAME = 'ACTIVE_JOB_INFO'
 ORDER BY ORDINAL_POSITION;
```

**Without the Premium Package for i**, use the `ibmi` CLI (`ibmi sql "..."`, `ibmi columns QSYS2 USER_INFO`,
`ibmi validate "..."`) or an IBM i MCP Server started with `--builtin-tools --execute-sql`.

## 3. Prototype and test the SQL live

Draft the statement with `:param_name` placeholders, then test it with `execute_sql_statement` in IBM i Developer mode:

1. **Substitute literal test values** for each `:param` (the dev-mode tool has no binding), e.g.
   `:user_name` → `'QSECOFR'`. Keep a copy of the parameterized version; that's what goes in the YAML.
2. **Cap test output**: append `FETCH FIRST 5 ROWS ONLY` while iterating.
3. **Test every path**: each parameter's default value, a value that returns zero rows, sentinel values such
   as `'*ALL'`, and boundary values for numeric limits.
4. **Check the result columns**: alias cryptic columns, drop ones the agent won't need, and order rows so
   the most useful come first.
5. **Check cost**: if a test is slow, add filters or push them into table-function arguments, which the
   service evaluates server-side, instead of filtering in `WHERE`.

**Safety rules for testing:**

- Only run `SELECT`, `WITH`, or `VALUES` statements while testing. `execute_sql_statement` also runs DDL/DML.
- For a write tool (`INSERT`, `UPDATE`, `DELETE`, `CALL`, `QSYS2.QCMDEXC`), **do not execute it to test it**.
  Show the SQL and ask the user. Only run it if they explicitly approve, against a test library they name.
- Never put credentials in SQL, YAML, or chat output.

Present the final parameterized SQL to the user with a sample of real results, and confirm before writing YAML.

## 4. Write the YAML

Read `references/yaml-reference.md` first. The minimum shape:

```yaml
sources:
  ibmi-system:
    host: ${DB2i_HOST}
    user: ${DB2i_USER}
    password: ${DB2i_PASS}
    port: 8076
    ignore-unauthorized: true

tools:
  list_active_jobs_for_user:
    source: ibmi-system
    description: >-
      List active jobs for a user profile, highest CPU first. Returns job name,
      type, status, CPU time, and temporary storage.
    statement: |
      SELECT JOB_NAME, JOB_TYPE, JOB_STATUS, CPU_TIME, TEMPORARY_STORAGE
        FROM TABLE(QSYS2.ACTIVE_JOB_INFO(CURRENT_USER_LIST_FILTER => :user_name)) X
       ORDER BY CPU_TIME DESC
       FETCH FIRST :max_rows ROWS ONLY
    parameters:
      - name: user_name
        type: string
        description: "User profile to filter on, uppercase (e.g. 'QSECOFR')"
        required: true
        pattern: "^[A-Z0-9$#@_]{1,10}$"
      - name: max_rows
        type: integer
        description: "Maximum jobs to return"
        default: 25
        min: 1
        max: 100
    security:
      readOnly: true
    annotations:
      title: "Active Jobs for User"
      readOnlyHint: true
      idempotentHint: true
      domain: "system"
      category: "jobs"

toolsets:
  job_monitoring:
    title: "Job Monitoring"
    description: "Inspect active jobs"
    tools:
      - list_active_jobs_for_user
```

Rules that matter most:

- **Bind every input with `:param_name`.** Never splice values into SQL text.
- **Every `:name` in the statement must be declared in `parameters`, and vice versa.**
- Parameters are **required unless they have a `default` or `required: false`**. An omitted optional
  parameter with no default binds as `''` for every type, **never NULL**, so `:x IS NULL` never matches.
  For "no filter", give a sentinel default and test for it: `(:lib = '*ALL' OR LIBRARY_NAME = :lib)`.
- Bound row limit: `FETCH FIRST n ROWS ONLY` (or a `max_rows` parameter) for anything that can grow.
  The server fetches at most 100 rows per call unless the tool sets `rowsToFetch`, so a limit above 100
  needs `rowsToFetch` as well.
- Tool and parameter names are `snake_case`, verb first (`list_`, `get_`, `find_`, `count_`).
- The `description` is what the agent reads to decide when to call the tool. Say what it returns and when
  to use it. Parameter descriptions should include an example value and format.
- Write tools need `security.readOnly: false` and `annotations.readOnlyHint: false` / `destructiveHint: true`.
  Otherwise the server rejects the statement.

## 5. Validate

Run the bundled validator (Node 20+). `<skill-dir>` is this skill's directory. On first use, install its two
dependencies (`ajv`, `js-yaml`) into the skill's `scripts/` folder:

```bash
npm install --prefix <skill-dir>/scripts            # once; skip if scripts/node_modules exists

node <skill-dir>/scripts/validate-tools.mjs tools-tmp/my-tools.yaml
# multiple files or whole directories; cross-file source/toolset references are checked together
node <skill-dir>/scripts/validate-tools.mjs tools-tmp/ other-tools/
# load DB2i_* vars the way the server does
node --env-file=.env <skill-dir>/scripts/validate-tools.mjs tools-tmp/my-tools.yaml
```

It checks:

- **Schema**: YAML parses and matches `assets/sql-tools-config.json` (required fields, types, enums, unknown keys).
- **Bindings**: undeclared `:params`, unused parameters, `:` followed by a digit (the server rejects it, even inside a
  literal like `'12:30'`), placeholders in a tool with no parameters, optional parameters with no default,
  `:param IS NULL` tests, array parameters not wrapped in `( )`.
- **Security**: non-`SELECT/WITH/VALUES` statements that are not marked `security.readOnly: false`.
- **References**: every tool's `source` and every toolset entry exists across all files given.

Exit code `0` = valid (warnings allowed), `1` = errors, `2` = usage/setup problem. Fix every error and
re-run until it exits `0`. Address warnings or tell the user why one is intentional.

## 6. Hand off: start the server

Finish by giving the user a command to start the MCP server with their tools. Fill in the real file path and toolset name(s):

```bash
npx -y @ibm/ibmi-mcp-server@latest --transport http --tools tools-tmp/my-tools.yaml --toolsets job_monitoring
```

- Connection settings come from `DB2i_HOST`, `DB2i_USER`, `DB2i_PASS` (and optional `DB2i_PORT`) in the environment
  or a `.env` file in the current directory. If they aren't set, say so and show which variables to set.
- `--toolsets` is optional; omit it to load every tool in the file. `--tools` also accepts a directory.
- HTTP mode serves MCP at `http://127.0.0.1:3010/mcp`. For an MCP client that launches the server itself,
  use `--transport stdio` instead.

Offer to start it for the user. Run it in the background if they agree, since the server keeps running.
