# YAML Tool Reference (cheat sheet)

The authoritative definition is `../assets/sql-tools-config.json` (the schema). Full field docs and
working examples are in the server repo:
[tools/README.md](https://github.com/IBM/ibmi-mcp-server/blob/main/tools/README.md) and
[tools/](https://github.com/IBM/ibmi-mcp-server/tree/main/tools).
This sheet covers what you need most often, plus behaviors confirmed in the server source.

## File layout

A file contains at least one of `sources`, `tools`, `toolsets`. Files passed together to `--tools`
(or a directory) are merged, so a tool may reference a source defined in another file.

```yaml
sources:        # connection(s); ${VAR} is replaced from the environment before parsing
tools:          # tool_name -> definition
toolsets:       # toolset_name -> { title, description, tools: [tool_name, ...] }
```

## `sources.<name>`

| Field | Req | Notes |
|-------|-----|-------|
| `host`, `user`, `password` | yes | Always `${DB2i_HOST}`, `${DB2i_USER}`, `${DB2i_PASS}`. Never literals |
| `port` | | Mapepire port, default 8076 |
| `ignore-unauthorized` | | `true` for self-signed certificates |
| `jdbc-options` | | e.g. `libraries: [MYLIB, QGPL]`, `naming: system` |

## `tools.<name>`

| Field | Req | Notes |
|-------|-----|-------|
| `source` | yes | A key under `sources` |
| `description` | yes | LLM-facing: what it returns, when to use it |
| `statement` | yes* | SQL with `:param` placeholders (*the schema allows omitting it; the server rejects that) |
| `parameters` | | See below |
| `security.readOnly` | | Default `true`. Non-`SELECT/WITH/VALUES` (including `CALL`) needs `false` |
| `security.maxQueryLength`, `security.forbiddenKeywords` | | Extra guardrails |
| `annotations` | | `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `domain`, `category` |
| `responseFormat` | | `json` (default) or `markdown` |
| `tableFormat` | | `markdown` (default), `ascii`, `grid`, `compact` |
| `maxDisplayRows` | | Display truncation only (1–1000, default 100) |
| `rowsToFetch` | | Rows fetched from Db2 per call. **Default 100**, so set it if the tool can return more |
| `fetchAllRows` | | Page through everything (capped by `IBMI_PAGINATION_MAX_ROWS`). Small catalogs only |
| `enabled` | | `false` keeps the tool defined but unregistered |

Unknown keys are schema errors (`additionalProperties: false`).

## `parameters[]`

| Field | Applies to | Notes |
|-------|-----------|-------|
| `name` | all | snake_case; must match `:name` in the statement |
| `type` | all | `string`, `integer`, `float`, `boolean`, `array` |
| `description` | all | Include an example value and the expected format |
| `required` | all | Required by default unless `default` is set or `required: false` |
| `default` | all | Used when the caller omits the parameter |
| `enum` | string/number | Allowed values; shown to the LLM |
| `pattern` | string | Regex, e.g. `^[A-Z0-9$#@_]{1,10}$` for an object name |
| `min`, `max` | integer/float | Inclusive bounds |
| `minLength`, `maxLength` | string/array | Length or item-count bounds |
| `itemType` | array | Required for arrays: `string`, `integer`, `float`, `boolean` |

### Binding behavior (verified against the server)

- The server masks string literals, delimited identifiers (`"..."`) and comments, then finds placeholders
  with `/:(\w+)/g` in the remaining SQL code. A `:` followed by a digit inside a literal (e.g. `'12:30'`,
  `'::1'`) is fine. A `:` followed by a digit in SQL code is rejected when the tool has parameters, as is an
  unterminated quote.
- A tool with **no** `parameters` sends its SQL unchanged. Any `:name` left in it is a SQL error.
- An omitted optional parameter with no default binds as `''` for **every** type, never `NULL`.
  `:x IS NULL` therefore never matches, and `''` into a numeric comparison fails at runtime.
- An array parameter expands to `?, ?, ?` **without** parentheses, so write `IN (:ids)`.
  Callers pass a JSON array (`["A","B"]`), not a string.

## SQL patterns for Db2 for i

**Optional filter with a sentinel default**

```yaml
statement: |
  SELECT OBJNAME, OBJTYPE, OBJSIZE
    FROM TABLE(QSYS2.OBJECT_STATISTICS(:library, '*ALL')) X
   WHERE (:object_type = '*ALL' OR OBJTYPE = :object_type)
   FETCH FIRST 50 ROWS ONLY
parameters:
  - { name: library, type: string, required: true, description: "Library name (e.g. 'QGPL')" }
  - { name: object_type, type: string, default: "*ALL", description: "Object type (e.g. '*PGM') or '*ALL'" }
```

**Push filters into table-function arguments** (named `=>` arguments are evaluated by the service,
which is much cheaper than `WHERE` on the full result):

```sql
SELECT JOB_NAME, CPU_TIME
  FROM TABLE(QSYS2.ACTIVE_JOB_INFO(SUBSYSTEM_LIST_FILTER => :subsystem)) X
```

**Case-insensitive search**

```sql
WHERE UPPER(SERVICE_NAME) LIKE '%' CONCAT UPPER(:search_term) CONCAT '%'
```

**Untyped parameter markers.** If Db2 reports SQL0418 (a parameter marker is not valid here, typically
when both sides of an operator are markers or the marker is in a select list), give it a type:
`CAST(:name AS VARCHAR(128))`, `CAST(:days AS INTEGER)`.

**Relative timestamps**

```sql
WHERE LAST_USED_TIMESTAMP < CURRENT TIMESTAMP - :days_unused DAYS
```

**Row limits**: `FETCH FIRST :max_rows ROWS ONLY` binds fine. Pair it with `max` on the parameter and with
`rowsToFetch` if the max exceeds 100.

## Naming and descriptions

- Tools: `verb_noun` snake_case (`list_`, `get_`, `find_`, `count_`, `check_`, `analyze_`), unique across all loaded files.
- Toolsets: group by task (`job_monitoring`, `security_audit`), not by SQL service.
- Description: lead with what it returns, then when to use it, then notable limits
  ("Returns at most 50 rows", "Requires *ALLOBJ to see other users' jobs", "IBM i 7.4 TR5+").

## Write tools

Only when the user asks for one. Required settings:

```yaml
security:
  readOnly: false
annotations:
  readOnlyHint: false
  destructiveHint: true      # for DELETE/DROP/UPDATE-style effects
  idempotentHint: false
```

Constrain inputs tightly (`enum`, `pattern`, `max`) and say in the description exactly what changes.
Never test a write statement on the system without the user's explicit approval (see SKILL.md §3).
