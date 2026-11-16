# IBM i CLI (`ibmi`)

Command-line interface for querying, exploring, and managing IBM i systems via Db2 for i.

```
ibmi <command> [options]
```

---

## Install

```bash
# Published package (recommended)
npm i -g @ibm/ibmi-cli

# Or from a local checkout
npm run build && npm link -w @ibm/ibmi-cli
```

## Quick Start

```bash
# Option A: Configure via .ibmi/config.yaml
ibmi system add dev --host myhost.com --user MYUSER --password '${DB2i_PASS}'

# Option B: Use existing DB2i_* env vars from .env (zero config)
# The CLI falls back to DB2i_HOST, DB2i_USER, DB2i_PASS automatically

# Run a query
ibmi sql "SELECT * FROM SAMPLE.EMPLOYEE FETCH FIRST 5 ROWS ONLY"

# Run a YAML-defined tool
ibmi tool system_status --tools ../../tools/performance/performance.yaml
```

---

## Global Options

These apply to every command:

| Flag | Description |
|------|-------------|
| `--system <name>` | Target a specific configured system |
| `--format <type>` | `table`, `json`, `csv`, or `markdown` |
| `--raw` | Shorthand for `--format json` |
| `--stream` | NDJSON output (one JSON object per line); implies JSON unless `--format` is given |
| `--output <path>` | Write output to a file instead of stdout (commands that query a system: `sql`, `tool`, `schemas`, `tables`, `columns`, `related`, `describe`, `validate`) |
| `--watch <seconds>` | Re-run command at interval (Ctrl+C to stop); same commands as `--output`. With `--output`, the file is rewritten after every run |
| `--tools <path>` | Path to YAML tool file(s), comma-separated |
| `--no-color` | Disable colored output |

**Format priority:** `--raw` → `--format` → config `format` → auto-detect (TTY=table, piped=json). Set a default in your config to always get the same format regardless of TTY:

```yaml
format: table   # always render tables, even when piped
```

---

## Commands

### `ibmi sql [statement]` — Execute SQL

```bash
ibmi sql "SELECT * FROM SAMPLE.EMPLOYEE FETCH FIRST 10 ROWS ONLY"
ibmi sql --file query.sql
cat query.sql | ibmi sql
ibmi sql "SELECT * FROM SAMPLE.EMPLOYEE" --dry-run      # preview only
ibmi sql "SELECT * FROM SAMPLE.EMPLOYEE" --format csv --output results.csv
ibmi sql "SELECT JOB_NAME FROM TABLE(QSYS2.ACTIVE_JOB_INFO())" --watch 5
```

| Option | Description | Default |
|--------|-------------|---------|
| `--file <path>` | Read SQL from a file | — |
| `--limit <n>` | Max rows returned | system `maxRows` (5000) |
| `--read-only` / `--no-read-only` | Enforce or disable read-only mode | `--read-only` |
| `--dry-run` | Print SQL without executing (no connection needed) | — |
| `--yes` | Skip the prompt for systems with `confirm: true` | — |

SQL source priority: positional argument > `--file` > piped stdin.

**Row limit.** The limit is `--limit`, otherwise the system's `maxRows`. For a `SELECT`, `WITH` or `VALUES` statement the CLI appends `FETCH FIRST n ROWS ONLY`, unless the statement contains a comment, already has `FETCH FIRST`/`LIMIT`/`OFFSET`, or ends in a clause such as `FOR READ ONLY` or `WITH UR`. In every case the returned rows are cut to the limit. When rows were dropped, `meta.hasMore` is `true` and the table footer says `(limited to N rows — raise --limit for more)`.

#### Multi-system execution

Run the same query against multiple systems in parallel by passing comma-separated names to `--system`. Each name must be defined in your config file (`~/.ibmi/config.yaml` or project `.ibmi/config.yaml`).

```bash
ibmi sql "SELECT * FROM SAMPLE.EMPLOYEE FETCH FIRST 5 ROWS ONLY" --system dev,prod
ibmi sql "SELECT JOB_NAME FROM TABLE(QSYS2.ACTIVE_JOB_INFO())" --system dev,prod --format json
ibmi sql "SELECT * FROM QSYS2.SYSTEM_STATUS_INFO" --system dev,prod --stream
```

Each row includes a `SYSTEM` column. JSON output includes a `systems` array with per-system row counts, timing, and errors. If one system is unreachable, its results appear as an error row without affecting the others, and the command exits with code `1`. A system whose result was cut at the row limit has `"hasMore": true` in its `systems` entry and `(truncated)` in the table footer. `--watch` is not supported with multiple systems.

If any target system has `confirm: true`, the CLI asks once for all of them (`Execute on [dev, prod]? (y/N)`). Without a terminal it does not run: pass `--yes`, or the command fails with exit code `2`.

### `ibmi describe <objects>` — Generate DDL

Generate DDL (CREATE statements) for one or more SQL objects via `QSYS2.GENERATE_SQL`.

```bash
ibmi describe "SAMPLE.EMPLOYEE"
ibmi describe "SAMPLE.EMPLOYEE,SAMPLE.DEPARTMENT"
ibmi describe "QSYS2.SYSCOLUMNS" --type VIEW
ibmi describe "SYSCOLUMNS" --type VIEW          # defaults library to QSYS2
```

| Option | Description | Default |
|--------|-------------|---------|
| `--type <type>` | Object type (`TABLE`, `VIEW`, `INDEX`, `PROCEDURE`, `FUNCTION`, etc.) | `TABLE` |

Objects are specified as `LIBRARY.OBJECT` or just `OBJECT` (defaults to `QSYS2`). When describing multiple objects, each is queried independently — a failure on one produces an `ERROR:` row without crashing. The command exits with code `3` only when every object failed.

### `ibmi tool <name>` — Run a YAML Tool

```bash
ibmi tool system_status --tools ../../tools/performance/performance.yaml
ibmi tool get_table_data --schema SAMPLE --table EMPLOYEE --tools ./custom.yaml
ibmi tool active_job_info --dry-run --tools ../../tools/performance/performance.yaml
```

Each YAML tool's parameters become CLI flags automatically (`snake_case` → `--kebab-case`). A flag the tool does not define, a flag missing its value, or a value of the wrong type is rejected with exit code `2` (usage error) before any connection is made.

| Option | Description |
|--------|-------------|
| `--dry-run` | Show resolved SQL and parameters without executing |

Requires `--tools` to specify the YAML file(s).

### `ibmi tools` — List Available Tools

```bash
ibmi tools --tools ../../tools/                          # list all tools
ibmi tools --toolset performance --tools ../../tools/     # filter by toolset
ibmi tools show system_status --tools ../../tools/        # show tool details
```

### `ibmi toolsets` — List Toolsets

```bash
ibmi toolsets --tools ../../tools/
```

### `ibmi system` — Manage Connections

```bash
ibmi system list                          # list all configured systems
ibmi system show dev                      # show system details
ibmi system add dev --host h --user u     # add (prompts for missing fields)
ibmi system add prod --host h --user u --verify-tls   # verify the TLS certificate
ibmi system remove dev                    # remove a system
ibmi system default dev                   # set default system
ibmi system test dev                      # test connectivity (live)
ibmi system test --all                    # test all systems
ibmi system config-path                   # show config file locations
```

`system add` does not verify the server's TLS certificate unless `--verify-tls` is given (it stores `ignoreUnauthorized: false`). `system show` reports this as `verifyTls`, and `system list` as the `VERIFY_TLS` column.

### `ibmi config show` — Inspect Configuration

```bash
ibmi config show                          # merged config with the origin of each setting
```

### `ibmi schemas` — List Schemas

```bash
ibmi schemas
ibmi schemas --filter "MY%"
ibmi schemas --system-schemas             # include Q* and SYS* schemas
```

### `ibmi tables <schema>` — List Tables

```bash
ibmi tables SAMPLE
ibmi tables QSYS2 --filter "SYS%"
```

### `ibmi columns <schema> <table>` — Column Metadata

```bash
ibmi columns SAMPLE EMPLOYEE
```

### `ibmi related <library> <object>` — Related Objects

```bash
ibmi related SAMPLE EMPLOYEE
ibmi related SAMPLE EMPLOYEE --type INDEX
```

### `ibmi validate "<sql>"` — Validate SQL

```bash
ibmi validate "SELECT * FROM SAMPLE.EMPLOYEE"
```

Exits with code `3` when the syntax or table check is `FAIL`.

### `ibmi completion [shell]` — Shell Completions

```bash
# Auto-detect shell
eval "$(ibmi completion)"

# Explicit shell
eval "$(ibmi completion bash)"    # add to ~/.bashrc
eval "$(ibmi completion zsh)"     # add to ~/.zshrc
ibmi completion fish | source     # add to Fish config
```

---

## Configuration

### Config Files

The CLI loads config from two locations (project overrides user):

| Scope | Path |
|-------|------|
| **Project** | Nearest `.ibmi/config.yaml` walking up from `cwd` |
| **User** | `~/.ibmi/config.yaml` |

Example `.ibmi/config.yaml`:

```yaml
default: dev
format: table    # optional: table, json, csv, markdown
systems:
  dev:
    host: ${DB2i_HOST}
    port: 8076
    user: ${DB2i_USER}
    password: ${DB2i_PASS}
    readOnly: false
    confirm: false
    timeout: 60
    maxRows: 5000
    ignoreUnauthorized: true
  prod:
    host: prod400.example.com
    port: 8076
    user: ${PROD_USER}
    password: ${PROD_PASS}
    readOnly: true
    confirm: true
```

`${VAR}` references are expanded from environment variables at load time.

The CLI writes the user config file `~/.ibmi/config.yaml` with mode `0600` (owner read/write only), because it can hold plaintext passwords.

### System Resolution Order

When a command needs a system connection, the CLI resolves it in this order:

1. `--system <name>` flag
2. `IBMI_SYSTEM` environment variable
3. `default:` in config file
4. Only system configured (implicit default)
5. Legacy `DB2i_HOST` / `DB2i_USER` / `DB2i_PASS` environment variables

### Password Resolution

1. Config `password` field (with `${ENV_VAR}` expansion)
2. Interactive prompt (TTY only, hidden input)
3. Error if non-interactive and no password available

---

## Output Formats

### Table (default for TTY)

```
┌────────────────┬───────┐
│ SCHEMA_NAME    │ TYPE  │
├────────────────┼───────┤
│ MYLIB          │ USER  │
└────────────────┴───────┘
[dev] myhost.com · 1 row · 0.25s
```

Columns are as wide as their longest value; cell values are not truncated. For wide results use `--format json` or `--format csv`.

### JSON (default for pipes)

```json
{
  "ok": true,
  "system": "dev",
  "host": "myhost.com",
  "command": "list_schemas",
  "data": [{"SCHEMA_NAME": "MYLIB", "TYPE": "USER"}],
  "meta": {"rows": 1, "hasMore": false, "elapsed_ms": 250}
}
```

### NDJSON (`--stream`)

```
{"SCHEMA_NAME":"MYLIB","TYPE":"USER"}
{"SCHEMA_NAME":"QSYS2","TYPE":"SYSTEM"}
```

### CSV (`--format csv`)

```
SCHEMA_NAME,TYPE
MYLIB,USER
```

Object and array values are written as JSON text.

### JSON Error

```json
{
  "ok": false,
  "error": {"code": "SQL_ERROR", "message": "..."}
}
```

---

## Exit Codes

| Code | Name | When |
|------|------|------|
| `0` | SUCCESS | Command completed |
| `1` | GENERAL | Connection failure, unexpected error |
| `2` | USAGE | Invalid arguments or missing options |
| `3` | QUERY | SQL execution error |
| `4` | SECURITY | Read-only violation, forbidden operation |
| `5` | AUTH | Authentication failure |

How the code is chosen, in order: a usage error is always `2`; a network or TLS failure (`ECONNREFUSED`, a certificate error, ...) is `1` `CONNECTION_ERROR`; then the SQLSTATE the database reports decides (class `08` is a connection error, class `28` is `5`, any other is `3`); then the server's error code (read-only and forbidden-statement violations are `4`). The message text is only a fallback. A SQL error that merely mentions a word such as `AUTHORS` or `PASSWORD_HASH` is `3`, not `5`.

Commands that report instead of failing still set an exit code:

- `ibmi validate` exits `3` when a check is `FAIL`. The report is still printed, with `"ok": true` in JSON.
- `ibmi describe` exits `3` when DDL generation failed for every object. A partial failure exits `0`.
- `ibmi sql --system a,b` exits `1` when any system failed.

---

## Upgrading

Changes in behaviour since 0.6.x:

| Changed | What to do |
|---------|------------|
| Node.js | Node.js 22.17 or later is required. |
| Exit codes | Derived from the SQLSTATE or error code before the message text. SQL errors that mention words like `AUTHORS` or "not authorized" now exit `3` instead of `5`; read-only violations exit `4` instead of `1`. |
| `ibmi validate`, `ibmi describe` | `validate` exits `3` on a `FAIL` check, and `describe` exits `3` when every object failed (both were `0`). A malformed object reference in `describe` exits `2`. |
| Multi-system `ibmi sql` | Exits `1` when any system fails (was `0`). Honours `confirm: true`: it asks once, and without a terminal it needs `--yes`. |
| Row limit | `--limit` / `maxRows` is always applied to the returned rows. `FETCH FIRST` is no longer appended to statements where it would be invalid. |
| `--watch` with `--output` | The file is rewritten after every run instead of being written once on Ctrl+C. |
| `ibmi tool` | Honours `--watch`; `--dry-run` honours `--output`. |
| Tables | Cell values are no longer truncated at 50 characters. |
| CSV | Object and array values are written as JSON instead of `[object Object]`. |
| `.env` lookup | Only `.env` in the working directory (or the file named by `MCP_SERVER_CONFIG`) is loaded; `../.env` is not. |

---

## Agent Integration

The CLI is designed for programmatic use by AI agents and shell scripts.

### Piped JSON by Default

When stdout is not a TTY, the CLI automatically outputs JSON. Agents can parse structured results without specifying `--format json`.

```bash
result=$(ibmi sql "SELECT COUNT(*) AS CNT FROM SAMPLE.EMPLOYEE")
count=$(echo "$result" | jq '.data[0].CNT')
```

### NDJSON for Streaming

Use `--stream` to get one JSON object per row — ideal for incremental processing:

```bash
ibmi sql "SELECT * FROM SAMPLE.EMPLOYEE" --stream | while IFS= read -r row; do
  echo "$row" | jq '.EMPNO'
done
```

### Exit Code Routing

Agents can branch on exit codes for error handling:

```bash
ibmi sql "SELECT 1 FROM SYSIBM.SYSDUMMY1" --system prod
case $? in
  0) echo "OK" ;;
  1) echo "Connection failed" ;;
  3) echo "SQL error" ;;
  5) echo "Auth failed" ;;
esac
```

### Dry-Run for Planning

Agents can use `--dry-run` to preview SQL without executing:

```bash
ibmi sql "SELECT * FROM SAMPLE.EMPLOYEE" --dry-run
ibmi tool my_report --schema SAMPLE --dry-run --tools ./tools.yaml
```

### File Output for Pipelines

```bash
ibmi sql "SELECT * FROM SAMPLE.EMPLOYEE" --format csv --output /tmp/employees.csv
```

With `--watch`, the file is rewritten after every run.

### Watch for Monitoring

```bash
ibmi sql "SELECT * FROM TABLE(QSYS2.ACTIVE_JOB_INFO()) WHERE JOB_STATUS = 'RUN'" --watch 10
```

---

## Architecture

```
packages/cli/src/
├── index.ts                   # Executable entry point (the `ibmi` bin): parses argv
├── program.ts                 # Program setup, global options, command registration
├── commands/
│   ├── sql.ts                 # ibmi sql — direct SQL execution (+ multi-system)
│   ├── describe.ts            # ibmi describe — DDL generation
│   ├── tool.ts                # ibmi tool — YAML tool execution
│   ├── tools-list.ts          # ibmi tools / toolsets — tool discovery
│   ├── system.ts              # ibmi system — connection management
│   ├── config.ts              # ibmi config show — active configuration with origins
│   ├── schemas.ts             # ibmi schemas
│   ├── tables.ts              # ibmi tables
│   ├── columns.ts             # ibmi columns
│   ├── related.ts             # ibmi related
│   ├── validate.ts            # ibmi validate
│   └── completion.ts          # ibmi completion — shell completions
├── config/
│   ├── types.ts               # TypeScript interfaces
│   ├── schema.ts              # Zod validation schemas
│   ├── loader.ts              # Config file discovery, parsing, merging
│   ├── resolver.ts            # System resolution chain
│   └── credentials.ts         # Password expansion and interactive prompts
├── formatters/
│   └── output.ts              # Table, JSON, CSV, NDJSON, file output, errors
└── utils/
    ├── command-helpers.ts      # withConnection wrapper, watch mode, format helpers
    ├── connection.ts           # DB2i_* env bridge to IBMiConnectionPool
    ├── multi-connection.ts     # Multi-system parallel execution via SourceManager
    ├── exit-codes.ts           # Semantic exit codes and error classification
    ├── yaml-loader.ts          # YAML tool file loading and merging
    └── yaml-to-commander.ts    # YAML parameters → Commander options
```

### Key Pattern: `withConnection`

Most data commands use the `withConnection(cmd, toolName, action)` wrapper which handles the full lifecycle:

1. Resolve target system
2. Connect (set env vars for the connection pool)
3. Execute the action callback
4. Render output (table/json/csv/ndjson)
5. Cleanup (close pool)
6. Set exit code on error

This keeps each command focused on its query logic.
