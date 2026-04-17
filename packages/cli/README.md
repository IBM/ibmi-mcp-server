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
ibmi tool system_status --tools ../tools/work-management.yaml
```

---

## Global Options

These apply to every command:

| Flag | Description |
|------|-------------|
| `--system <name>` | Target a specific configured system |
| `--format <type>` | `table`, `json`, `csv`, or `markdown` |
| `--raw` | Shorthand for `--format json` |
| `--stream` | NDJSON output (one JSON object per line) |
| `--output <path>` | Write output to a file instead of stdout |
| `--watch <seconds>` | Re-run command at interval (Ctrl+C to stop) |
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

SQL source priority: positional argument > `--file` > piped stdin.

#### Multi-system execution

Run the same query against multiple systems in parallel by passing comma-separated names to `--system`. Each name must be defined in your config file (`~/.ibmi/config.yaml` or project `.ibmi/config.yaml`).

```bash
ibmi sql "SELECT * FROM SAMPLE.EMPLOYEE FETCH FIRST 5 ROWS ONLY" --system dev,prod
ibmi sql "SELECT JOB_NAME FROM TABLE(QSYS2.ACTIVE_JOB_INFO())" --system dev,prod --format json
ibmi sql "SELECT * FROM QSYS2.SYSTEM_STATUS_INFO" --system dev,prod --stream
```

Each row includes a `SYSTEM` column. JSON output includes a `systems` array with per-system row counts, timing, and errors. If one system is unreachable, its results appear as an error row without affecting the others. `--watch` is not supported with multiple systems.

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

Objects are specified as `LIBRARY.OBJECT` or just `OBJECT` (defaults to `QSYS2`). When describing multiple objects, each is queried independently — a failure on one produces an `ERROR:` row without crashing.

### `ibmi tool <name>` — Run a YAML Tool

```bash
ibmi tool system_status --tools ../tools/work-management.yaml
ibmi tool get_table_data --schema SAMPLE --table EMPLOYEE --tools ../tools/custom.yaml
ibmi tool list_jobs --dry-run --tools ../tools/work-management.yaml
```

Each YAML tool's parameters become CLI flags automatically (`snake_case` → `--kebab-case`).

| Option | Description |
|--------|-------------|
| `--dry-run` | Show resolved SQL and parameters without executing |

Requires `--tools` to specify the YAML file(s).

### `ibmi tools` — List Available Tools

```bash
ibmi tools --tools ../tools/                          # list all tools
ibmi tools --toolset work_management --tools ../tools/ # filter by toolset
ibmi tools show system_status --tools ../tools/        # show tool details
```

### `ibmi toolsets` — List Toolsets

```bash
ibmi toolsets --tools ../tools/
```

### `ibmi system` — Manage Connections

```bash
ibmi system list                          # list all configured systems
ibmi system show dev                      # show system details
ibmi system add dev --host h --user u     # add (prompts for missing fields)
ibmi system remove dev                    # remove a system
ibmi system default dev                   # set default system
ibmi system test dev                      # test connectivity (live)
ibmi system test --all                    # test all systems
ibmi system config-path                   # show config file locations
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

### Watch for Monitoring

```bash
ibmi sql "SELECT * FROM TABLE(QSYS2.ACTIVE_JOB_INFO()) WHERE JOB_STATUS = 'RUN'" --watch 10
```

---

## Architecture

```
src/cli/
├── index.ts                   # Program setup, global options, command registration
├── commands/
│   ├── sql.ts                 # ibmi sql — direct SQL execution (+ multi-system)
│   ├── describe.ts            # ibmi describe — DDL generation
│   ├── tool.ts                # ibmi tool — YAML tool execution
│   ├── tools-list.ts          # ibmi tools / toolsets — tool discovery
│   ├── system.ts              # ibmi system — connection management
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
