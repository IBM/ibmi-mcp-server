# IBM i MCP Server - SQL Tool Configurations

Tools for this MCP server are defined in YAML configuration files. This directory contains several example tool configuration files that can be used to monitor and manage IBM i systems.

There are three main sections in each YAML file:
- **sources**: Define database connections
- **tools**: Define individual SQL operations
- **toolsets**: Group related tools together for easier loading

## Tool Categories

This directory contains pre-built tool configurations organized by category:

| Directory | Category | Description | Key Tools |
|-----------|----------|-------------|-----------|
| [**sample/**](sample/) | Sample Data | Demonstration tools using IBM i SAMPLE schema (employee, department, project data) | Employee lookup, department analysis, project management |
| [**sys-admin/**](sys-admin/) | System Administration | High-level system service discovery and metadata exploration | Service catalogs, schema browsing, example queries |
| [**security/**](security/) | Security Analysis | Library list security assessment and vulnerability detection | Library list configuration, authority checks, security analysis |
| [**performance/**](performance/) | Performance Monitoring | System performance metrics and resource utilization | System status, active jobs, memory pools, HTTP server stats |
| [**developer/**](developer/) | Development Tools | Object statistics and dependency analysis for developers | Recently used objects, stale object detection, dependency tracking |

> **💡 Quick Start:** Use `--list-toolsets` to see all available toolsets:
> ```bash
> npx ibmi-mcp-server --list-toolsets --tools tools
> ```

Below is an overview of the structure and purpose of each section.

## Sources

The `sources` section defines database connection details. Each source includes:
- `host`: IBM i system hostname or IP
- `user`: Database user
- `password`: User password
- `port`: Database port (default: 8076)
- `ignore-unauthorized`: Whether to ignore SSL certificate errors

> `host`, `user`, and `password` are REQUIRED for each source.

Example:
```yaml
sources:
  ibmi-system:
    host: ${DB2i_HOST}
    user: ${DB2i_USER}
    password: ${DB2i_PASS}
    port: 8076
    ignore-unauthorized: true
```
> The environment variables DB2i_HOST, DB2i_USER, DB2i_PASS, and DB2i_PORT can be set in the server .env file.

## Tools

The `tools` section defines the actions that your agent can take. you can configure what system that the tool runs against, the SQL query to execute, parameters, security settings, etc.

Each tools requires:
- `name`: Unique tool name
- `source`: Source to use for database connection
- `description`: Description of the tool's purpose
- `statement`: SQL statement to execute

Optional fields:
- `enabled`: Whether the tool should be registered (default: `true`)
- `parameters`: Parameter definitions for dynamic SQL
- `security`: Security configuration
- `annotations`: Metadata for MCP clients
- `domain`: Domain categorization
- `category`: Category within domain

Example:
```yaml
tools:
  system_status:
    enabled: true  # Optional: defaults to true
    source: ibmi-system
    description: "Overall system performance statistics with CPU, memory, and I/O metrics"
    parameters: []
    statement: |
      SELECT * FROM TABLE(QSYS2.SYSTEM_STATUS(RESET_STATISTICS=>'YES',DETAILED_INFO=>'ALL')) X

```

### Enabling and Disabling Tools

You can enable or disable individual tools using the `enabled` field:

```yaml
tools:
  production_tool:
    enabled: true  # This tool will be registered (default)
    source: ibmi-system
    description: "Production-ready tool"
    statement: "SELECT * FROM production_table"

  experimental_tool:
    enabled: false  # This tool will be skipped during registration
    source: ibmi-system
    description: "Experimental tool - not ready for production"
    statement: "SELECT * FROM experimental_table"

  debug_tool:
    # Omitting 'enabled' defaults to true
    source: ibmi-system
    description: "Debug tool"
    statement: "SELECT * FROM debug_table"
```

**Use Cases:**
- **Development/Testing**: Temporarily disable production tools while testing
- **Gradual Rollout**: Enable tools incrementally as they're tested
- **Feature Flags**: Control tool availability without deleting configurations
- **Debugging**: Disable problematic tools without removing their definitions

**Note**: Disabled tools are completely skipped during parsing and will not be registered with the MCP server. They won't appear in tool listings or be available for execution.

### Parameters

Tools can accept parameters to make SQL queries dynamic and reusable. Parameters are validated before execution to ensure type safety and security. All parameters are bound securely to prevent SQL injection.

#### Parameter Reference

Parameters are used in SQL statements with the `:parameter_name` syntax. Each parameter must be defined in the `parameters` array with at least a `name` and `type`.

**Basic Structure:**
```yaml
parameters:
  - name: parameter_name      # Required: Name used in SQL statement
    type: string              # Required: Data type
    description: "..."        # Recommended: Description for LLM
    required: true            # Optional: Whether parameter is required
    default: "value"          # Optional: Default value if not provided
```

---

#### Parameter Types

| Type | Description | Use Cases | Constraints Available |
|------|-------------|-----------|----------------------|
| `string` | Text values | Library names, object names, patterns | `minLength`, `maxLength`, `pattern`, `enum` |
| `integer` | Whole numbers | Row limits, IDs, counts | `min`, `max`, `enum` |
| `float` | Decimal numbers | Thresholds, percentages, measurements | `min`, `max`, `enum` |
| `boolean` | True/false values | Flags, enable/disable options | None (inherently constrained) |
| `array` | List of values | Multiple filters, batch operations | `minLength`, `maxLength`, `itemType` |

---

#### Common Properties

These properties apply to all parameter types:

| Property | Required | Type | Description |
|----------|----------|------|-------------|
| `name` | ✅ Yes | string | Parameter name used in SQL (e.g., `:library_name`) |
| `type` | ✅ Yes | string | One of: `string`, `integer`, `float`, `boolean`, `array` |
| `description` | ⭐ Recommended | string | **LLM-facing description**—clear guidance on usage and examples |
| `required` | No | boolean | `true` = must be provided, `false` = optional (default: `true` unless `default` is set) |
| `default` | No | varies | Default value if parameter is not provided |

> **Important:** The `description` is sent directly to the LLM. Write clear, helpful descriptions with examples to guide the LLM in using the parameter correctly.

---

### String Parameters

String parameters accept text values and support length constraints, pattern matching, and enumerated values.

**Available Constraints:**
- `minLength`: Minimum string length
- `maxLength`: Maximum string length
- `pattern`: Regular expression validation
- `enum`: List of allowed values

**Example 1: Basic String Parameter**
```yaml
parameters:
  - name: library_name
    type: string
    description: "Library containing the file. Example: 'APPLIB', 'MYLIB'"
    required: true
```

**Example 2: String with Length Constraints**
```yaml
parameters:
  - name: object_name
    type: string
    description: "IBM i object name (1-10 characters)"
    required: true
    minLength: 1
    maxLength: 10
```

**Example 3: String with Pattern Validation**
```yaml
parameters:
  - name: library_name
    type: string
    description: "Library name (uppercase alphanumeric, starts with letter)"
    required: true
    pattern: "^[A-Z][A-Z0-9_]*$"
    maxLength: 10
```

**Example 4: String with Enum Values** *(from object-statistics-dev.yaml)*
```yaml
parameters:
  - name: sql_object_type
    type: string
    description: "SQL object type to find."
    required: false
    default: "INDEX"
    enum: [ALIAS, FUNCTION, INDEX, PACKAGE, PROCEDURE, ROUTINE, SEQUENCE, TABLE, TRIGGER, TYPE, VARIABLE, VIEW, XSR]
```
> When `enum` is provided, the description is automatically enhanced with "Must be one of: 'ALIAS', 'FUNCTION', ..." for LLM clarity.

---

### Integer Parameters

Integer parameters accept whole numbers and support minimum/maximum constraints and enumerated values.

**Available Constraints:**
- `min`: Minimum value (inclusive)
- `max`: Maximum value (inclusive)
- `enum`: List of allowed values

**Example 1: Basic Integer Parameter**
```yaml
parameters:
  - name: max_rows
    type: integer
    description: "Maximum number of rows to return"
    required: false
    default: 100
```

**Example 2: Integer with Range Constraints** *(from object-statistics-dev.yaml)*
```yaml
parameters:
  - name: months_unused
    type: integer
    description: "Look back this many months. Examples: 1 (past month), 3 (past 3 months), 6 (past 6 months)"
    required: false
    default: 1
    min: 1
    max: 120
```

**Example 3: Integer with Enum Values**
```yaml
parameters:
  - name: priority_level
    type: integer
    description: "Job priority level"
    required: false
    default: 5
    enum: [1, 5, 10, 20]
```

---

### Float Parameters

Float parameters accept decimal numbers and support minimum/maximum constraints.

**Available Constraints:**
- `min`: Minimum value (inclusive)
- `max`: Maximum value (inclusive)
- `enum`: List of allowed values

**Example 1: Basic Float Parameter**
```yaml
parameters:
  - name: cpu_threshold
    type: float
    description: "CPU usage threshold percentage (0.0 to 100.0)"
    required: false
    default: 80.0
    min: 0.0
    max: 100.0
```

**Example 2: Float for Decimal Precision**
```yaml
parameters:
  - name: memory_gb
    type: float
    description: "Memory size in gigabytes (supports decimals)"
    required: true
    min: 0.1
    max: 1024.0
```

---

### Boolean Parameters

Boolean parameters accept `true` or `false` values. They do not support additional constraints as they are inherently constrained to two values.

**Example 1: Simple Boolean Flag**
```yaml
parameters:
  - name: include_inactive
    type: boolean
    description: "Include inactive objects in results"
    required: false
    default: false
```

**Example 2: Boolean with Clear Documentation**
```yaml
parameters:
  - name: reset_statistics
    type: boolean
    description: "Reset statistics after retrieval. true = reset counters, false = preserve current values"
    required: false
    default: false
```

---

### Array Parameters

Array parameters accept lists of values and require an `itemType` to specify the type of elements in the array. They are **designed for SQL IN clauses** and automatically expand to multiple placeholders.

> **⚠️ IMPORTANT - Array Input Format**
> Array parameters must be passed as **JSON arrays**, not as strings containing SQL syntax.
>
> ✅ **Correct:**   `{"project_ids": ["MA2100", "AD3100"]}`
> 
> ❌ **Incorrect:** `{"project_ids": "('MA2100', 'AD3100')"}`
> 
> ❌ **Incorrect:** `{"project_ids": "MA2100,AD3100"}`

**Available Constraints:**
- `itemType`: **Required** - Type of array elements (`string`, `integer`, `float`, or `boolean`)
- `minLength`: Minimum number of items
- `maxLength`: Maximum number of items

> **💡 TIP - Array Parameters for IN Clauses**
> Array parameters are the recommended way to handle SQL IN clauses with variable-length lists. The server automatically expands array parameters into the correct number of placeholders, so you don't need to use other workarounds.

**Example 1: String Array**
```yaml
parameters:
  - name: library_list
    type: array
    itemType: string
    description: "List of library names to search (e.g., ['MYLIB', 'QGPL', 'QSYS'])"
    required: false
    minLength: 1
    maxLength: 50
```

**Example 2: Integer Array with Constraints**
```yaml
parameters:
  - name: job_numbers
    type: array
    itemType: integer
    description: "List of job numbers to analyze (e.g., [12345, 67890, 11111])"
    required: true
    minLength: 1
    maxLength: 100
```

**Using Arrays in SQL:**

Array parameters are automatically expanded to multiple placeholders for SQL `IN` clauses. **Simply use the array parameter name directly in the IN clause** - the server handles the expansion:

```yaml
statement: |
  SELECT * FROM SAMPLE.EMPPROJACT
  WHERE PROJNO IN (:project_ids)
```

**What happens internally:**
1. **Input JSON:** `{"project_ids": ["MA2100", "AD3100", "AD3110"]}`
2. **SQL with named parameter:** `WHERE PROJNO IN (:project_ids)`
3. **Automatic expansion:** `WHERE PROJNO IN (?, ?, ?)` (one placeholder per array element)
4. **Parameter binding:** Each `?` is bound to one array element: `"MA2100"`, `"AD3100"`, `"AD3110"`
5. **DB2 execution:** Standard prepared statement with bound parameters

**Key Benefits:**
- ✅ **No SQL injection risk** - Parameters are safely bound
- ✅ **Variable-length arrays** - Works with any array size (within constraints)
- ✅ **Simple syntax** - Just use `IN (:array_param)` in your SQL
- ✅ **Type validation** - Each array element is validated against `itemType`
- ✅ **No Db2-specific workarounds needed** - Works like standard JDBC parameter binding

> **📝 NOTE - SQL IN Clause Behavior**
> The `IN` clause uses **OR logic** - it matches records where the column equals **ANY** value in the list, not ALL values.
>
> ```sql
> WHERE PROJNO IN ('MA2100', 'AD3100')  -- Matches records with PROJNO = 'MA2100' OR 'AD3100'
> ```
>
> If you need **AND logic** (matching ALL values), you'll need different SQL patterns like subqueries or aggregation.

---

### Parameter Constraint Summary

| Constraint | Type Support | Description | Example |
|-----------|--------------|-------------|---------|
| `min` | integer, float | Minimum value (inclusive) | `min: 1` |
| `max` | integer, float | Maximum value (inclusive) | `max: 100` |
| `minLength` | string, array | Minimum length/count | `minLength: 1` |
| `maxLength` | string, array | Maximum length/count | `maxLength: 50` |
| `pattern` | string | Regular expression validation | `pattern: "^[A-Z][A-Z0-9]*$"` |
| `enum` | string, integer, float, boolean | Allowed values only | `enum: [INDEX, TABLE, VIEW]` |
| `itemType` | array | Type of array elements (**required**) | `itemType: string` |

---

### Best Practices for Parameter Descriptions

The `description` field is **sent directly to the LLM** to help it understand how to use the parameter. Follow these guidelines:

✅ **DO:**
- Provide clear, concise descriptions
- Include examples of valid values
- Explain the purpose and impact of the parameter
- Use IBM i terminology when applicable
- Indicate units for numeric values

```yaml
# Good examples
description: "Library name. Examples: 'MYLIB', '*LIBL', '*USRLIBL', '*ALLUSR'"
description: "Look back this many months. Examples: 1 (past month), 3 (past 3 months), 6 (past 6 months)"
description: "CPU usage threshold percentage (0.0 to 100.0). Values above this trigger alerts"
```

❌ **DON'T:**
- Use vague descriptions: ~~`"A library"`~~
- Omit examples: ~~`"Number of months"`~~
- Forget to document special values: ~~`"Library name"` (should mention `*LIBL`, etc.)~~

---

### Using Parameters in SQL Statements

Parameters are referenced in SQL statements using the `:parameter_name` syntax:

**Example: Parameter Binding**
```yaml
statement: |
  SELECT * FROM TABLE (
    qsys2.object_statistics(
      object_schema => :object_schema,
      objtypelist => '*ALL',
      object_name => '*ALL'
    )
  )
  WHERE sql_object_type = :sql_object_type
    AND last_used_timestamp < current_timestamp - :months_unused MONTHS
  ORDER BY last_used_timestamp DESC
```

**Handling Optional Parameters:**
```yaml
statement: |
  SELECT * FROM qsys2.library_info
  WHERE (:name_filter IS NULL OR library_name LIKE :name_filter)
    AND (:type_filter IS NULL OR library_type = :type_filter)
  ORDER BY library_name
```

**Using Default Values:**
```yaml
parameters:
  - name: name_filter
    type: string
    required: false  # NULL if not provided
  - name: max_rows
    type: integer
    required: false
    default: 100     # 100 if not provided
```

---

### Complete Parameter Examples

#### Example 1: Recently Used Objects *(from object-statistics-dev.yaml)*

```yaml
tools:
  find_recently_used_objects:
    source: ibmi-system
    description: Find objects that have been used within a specified time period
    statement: |
      SELECT * FROM TABLE (
        qsys2.object_statistics(
          object_schema => :object_schema,
          objtypelist => '*ALL',
          object_name => '*ALL'
        )
      )
      WHERE last_used_object = 'YES'
        AND sql_object_type = :sql_object_type
        AND last_used_timestamp < current_timestamp - :months_unused MONTHS
      ORDER BY last_used_timestamp DESC
    parameters:
      - name: object_schema
        type: string
        description: "Library name. Examples: 'MYLIB', '*LIBL', '*USRLIBL', '*ALLUSR'"
        required: true

      - name: sql_object_type
        type: string
        description: "SQL object type to find."
        required: false
        default: "INDEX"
        enum: [ALIAS, FUNCTION, INDEX, PACKAGE, PROCEDURE, ROUTINE, SEQUENCE, TABLE, TRIGGER, TYPE, VARIABLE, VIEW, XSR]

      - name: months_unused
        type: integer
        description: "Look back this many months. Examples: 1 (past month), 3 (past 3 months), 6 (past 6 months)"
        required: false
        default: 1
        min: 1
        max: 120
```

#### Example 2: Filtered Library Search

```yaml
tools:
  search_libraries:
    source: ibmi-system
    description: Search for libraries with filtering options
    statement: |
      SELECT library_name, library_type, library_size
      FROM qsys2.library_info
      WHERE (:name_pattern IS NULL OR library_name LIKE :name_pattern)
        AND (:type_filter IS NULL OR library_type = :type_filter)
        AND (:min_size IS NULL OR library_size >= :min_size)
      ORDER BY library_name
      FETCH FIRST :max_rows ROWS ONLY
    parameters:
      - name: name_pattern
        type: string
        description: "Library name pattern (use % for wildcards). Example: 'APP%' matches all libraries starting with APP"
        required: false
        pattern: "^[A-Z0-9%_*]+$"
        maxLength: 10

      - name: type_filter
        type: string
        description: "Filter by library type"
        required: false
        enum: ["PROD", "TEST"]

      - name: min_size
        type: integer
        description: "Minimum library size in bytes"
        required: false
        min: 0

      - name: max_rows
        type: integer
        description: "Maximum number of results to return"
        required: false
        default: 100
        min: 1
        max: 1000
```

---

### Parameter Validation

All parameters are validated before SQL execution:

1. **Type Validation**: Values must match the declared type
2. **Constraint Validation**: Values must satisfy min/max, length, pattern, and enum constraints
3. **SQL Security**: Parameters are bound securely to prevent SQL injection
4. **Required Check**: Required parameters must be provided (unless they have defaults)

**Validation Errors:**
- Invalid type: `Expected integer, got string`
- Out of range: `Value 150 exceeds maximum of 120`
- Pattern mismatch: `Value does not match pattern: ^[A-Z][A-Z0-9]*$`
- Enum violation: `Value 'INVALID' must be one of: 'INDEX', 'TABLE', 'VIEW'`
- Missing required: `Required parameter 'library_name' not provided`

---

## Output Format Options

SQL tools support configurable output formatting to optimize readability and control the display of query results. These options control how result sets are presented in markdown format, including table styling and row truncation.

> **⚠️ Important:** Output formatting options only apply when `responseFormat: markdown` is set (default is set to `json`). Tools using `responseFormat: json` will return raw JSON data without formatting.

### Overview

The output formatting system provides:
- **Multiple table styles** for different display contexts
- **Type-aware column alignment** (numeric right-aligned, text left-aligned)
- **NULL value handling** with configurable replacements
- **Row truncation** with clear truncation indicators
- **Metadata display** including execution time, row counts, and NULL statistics

All SQL tools use markdown formatting by default with sensible defaults that work well for most use cases. You can override these settings per tool to customize the output presentation.

---

### Output Format Configuration

Output formatting is configured using two optional fields in the tool definition:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `responseFormat` | enum | `markdown` | Response format (`markdown` or `json`) - **required for formatting** |
| `tableFormat` | enum | `markdown` | Table formatting style (see styles below) |
| `maxDisplayRows` | integer | `100` | Maximum rows to display before truncation |

The `tableFormat` and `maxDisplayRows` fields are optional. If omitted, the tool will use the default values.

---

### Table Format Styles

The `tableFormat` field controls the visual style of result tables. Four styles are available:

- `markdown` (default)
- `ascii`
- `grid`
- `compact`

#### 1. `markdown` (Default)

GitHub-flavored markdown table format with column type indicators. Best for documentation, web viewers, and LLM consumption.

**Characteristics:**
- Uses `|` for column separators
- Includes `---` header separator with alignment indicators
- Column headers include type information: `EMPLOYEE_ID (INTEGER)`
- Numeric columns automatically right-aligned
- Most readable in markdown renderers

**Example:**
```markdown
| EMPLOYEE_ID (INTEGER) | FIRST_NAME (VARCHAR) | SALARY (DECIMAL) |
|----------------------:|:---------------------|------------------:|
|                000010 | John                 |         75000.00 |
|                000020 | Alice                |         82500.00 |
```

**Use Cases:**
- Default choice for most tools
- Documentation and reports
- Web-based interfaces
- LLM-friendly output

---

#### 2. `ascii`

Plain ASCII table format using `+`, `-`, and `|` characters. Compatible with any text display.

**Characteristics:**
- Uses `+` for corners and intersections
- Uses `-` for horizontal borders
- Uses `|` for vertical borders
- Works in any text editor or terminal
- Fixed-width display for consistent alignment

**Example:**
```
+-------------+------------+----------+
| EMPLOYEE_ID | FIRST_NAME | SALARY   |
+-------------+------------+----------+
|      000010 | John       | 75000.00 |
|      000020 | Alice      | 82500.00 |
+-------------+------------+----------+
```

**Use Cases:**
- Plain text environments
- Email or text file output
- Legacy system integration
- Terminal-based tools

---

#### 3. `grid`

Unicode box-drawing characters for a polished, professional appearance.

**Characteristics:**
- Uses Unicode box-drawing characters (`│`, `┌`, `┐`, `├`, `┤`, `┴`, `┬`, `└`, `┘`)
- Visually distinct and modern
- Requires Unicode support
- Slightly more compact than ASCII

**Example:**
```
┌─────────────┬────────────┬──────────┐
│ EMPLOYEE_ID │ FIRST_NAME │ SALARY   │
├─────────────┼────────────┼──────────┤
│      000010 │ John       │ 75000.00 │
│      000020 │ Alice      │ 82500.00 │
└─────────────┴────────────┴──────────┘
```

**Use Cases:**
- Modern terminal output
- Professional reports
- Rich text environments
- Visual clarity over compatibility

---

#### 4. `compact`

Minimal spacing for space-constrained displays.

**Characteristics:**
- Reduced column padding (1 space instead of 2)
- Still uses markdown-style separators
- Maintains alignment and readability
- Most space-efficient option

**Example:**
```markdown
|EMPLOYEE_ID|FIRST_NAME|SALARY   |
|----------:|:---------|--------:|
|     000010|John      | 75000.00|
|     000020|Alice     | 82500.00|
```

**Use Cases:**
- Mobile or narrow displays
- High-density information display
- Logs with space constraints
- Minimalist output preferences

---

### Maximum Display Rows

The `maxDisplayRows` field controls how many rows are displayed before truncation occurs.

**Constraints:**
- Minimum: `1`
- Maximum: `1000`
- Default: `100`

**Behavior:**
- If result row count ≤ `maxDisplayRows`: All rows are displayed
- If result row count > `maxDisplayRows`: First `maxDisplayRows` rows shown with truncation alert

**Truncation Alert:**
When truncation occurs, a clear alert message is displayed:

```markdown
> ⚠️ **Truncated Results**
> Showing 100 of 1,247 rows. 1,147 additional rows were truncated.
```

**Use Cases for Different Limits:**

| Limit | Use Case |
|-------|----------|
| `1-10` | Quick previews, debugging |
| `10-50` | Interactive queries, dashboards |
| `50-100` | Standard reports (default) |
| `100-500` | Detailed analysis |
| `500-1000` | Comprehensive exports |

---

### Configuration Examples

#### Example 1: Default Configuration

Most tools work well with defaults (markdown format, 100-row limit):

```yaml
tools:
  list_employees:
    source: ibmi-system
    description: "List all employees"
    statement: "SELECT EMPNO, FIRSTNME, SALARY FROM SAMPLE.EMPLOYEE"
    # Defaults: responseFormat: markdown, tableFormat: markdown, maxDisplayRows: 100
```

---

#### Example 2: ASCII Format

```yaml
tools:
  system_status:
    source: ibmi-system
    description: "System status in plain text format"
    statement: "SELECT * FROM TABLE(QSYS2.SYSTEM_STATUS())"
    responseFormat: markdown  # Required for formatting
    tableFormat: ascii         # Plain text compatible
    maxDisplayRows: 50
```

**Use for:** Plain text files, emails, legacy terminals, non-Unicode systems

---

#### Example 3: Grid Format

```yaml
tools:
  monthly_report:
    source: ibmi-system
    description: "Monthly sales report"
    statement: "SELECT MONTH_NAME, TOTAL_SALES FROM SALES.MONTHLY_SUMMARY"
    responseFormat: markdown
    tableFormat: grid    # Unicode box characters
    maxDisplayRows: 12
```

**Use for:** Professional reports, dashboards, modern terminals

---

#### Example 4: Compact Format

```yaml
tools:
  active_jobs:
    source: ibmi-system
    description: "List active jobs"
    statement: "SELECT JOB_NAME, USER_NAME, CPU_USED FROM QSYS2.ACTIVE_JOB_INFO"
    responseFormat: markdown
    tableFormat: compact  # Minimal spacing
    maxDisplayRows: 200
```

**Use for:** Space-constrained displays, logs, high-density data

---

#### Example 5: High Row Limit

```yaml
tools:
  export_customers:
    source: ibmi-system
    description: "Export customer list"
    statement: "SELECT * FROM CUSTOMERS.MASTER WHERE STATUS = 'ACTIVE'"
    responseFormat: markdown
    maxDisplayRows: 1000  # Maximum allowed
```

**Use for:** Data exports, comprehensive analysis, admin tools

---

### Automatic Features

#### Column Type Awareness

Columns are automatically aligned based on database types:
- **Right-aligned:** INTEGER, DECIMAL, FLOAT, NUMERIC (all numeric types)
- **Left-aligned:** VARCHAR, CHAR, DATE, TIME, TIMESTAMP (text and temporal types)

Column headers include type information: `SALARY (DECIMAL)`

**Example Output:**

```markdown
| EMPNO (INTEGER) | FIRSTNME (VARCHAR) |  SALARY (DECIMAL) |
|----------------:|:-------------------|------------------:|
|          000010 | John               |          75000.00 |
```

#### NULL Value Handling

- NULL values display as `-` (dash)
- NULL counts tracked per column in metadata
- Consistent across all table formats

**Example Output with NULLs:**

```markdown
| EMPNO (INTEGER) | PHONENO (CHAR) | EMAIL (VARCHAR) |
|----------------:|:---------------|:----------------|
|          000010 | 555-0100       | john@example.com |
|          000020 | -              | -               |

### Metadata
- **NULL Values:** PHONENO (1), EMAIL (1)
```

---

### Complete Output Structure

A fully-formatted SQL tool response includes:

1. **Tool Name Header** (H2)
2. **Success Alert** with checkmark
3. **Result Table** with type-aware formatting
4. **Truncation Alert** (if applicable)
5. **Metadata Section** with:
   - Execution time
   - Row counts (displayed and total)
   - NULL value statistics
   - Parameter values used
6. **Performance Metrics** (optional)

**Example Complete Output:**

```markdown
## query_employees

> ✅ Query completed successfully

| EMPNO (INTEGER) | FIRSTNME (VARCHAR) | LASTNAME (VARCHAR) |  SALARY (DECIMAL) |
|----------------:|:-------------------|:-------------------|------------------:|
|          000010 | John               | Smith              |          75000.00 |
|          000020 | Alice              | Johnson            |          82500.00 |
|          000030 | Bob                | Williams           |          68000.00 |

### Metadata
- **Execution Time:** 0.156s
- **Rows Returned:** 3
- **NULL Values:** None

### Parameters
- **department**: 'A00'
- **min_salary**: 50000
```

---

### Best Practices

**Format Selection:**
- `markdown` - Default, best for LLMs and web UIs
- `ascii` - Plain text compatibility
- `grid` - Professional reports
- `compact` - Space-constrained displays

**Row Limits by Use Case:**
- Interactive tools: 10-50 rows
- Standard reports: 50-100 rows (default)
- Analysis tools: 100-500 rows
- Export tools: 500-1000 rows

**Performance:**
- Lower `maxDisplayRows` for faster responses
- Use SQL `LIMIT` clauses for database-level limits
- Add `ORDER BY` to show most relevant rows first

---

## Complete Example: Employee Information Tools

The `tools/sample/employee-info.yaml` file demonstrates a comprehensive set of tools using the IBM i SAMPLE schema. This example showcases all parameter types, validation patterns, and best practices for building production-ready MCP tools.

### File Overview

**Purpose:** Provide HR and project management capabilities using the SAMPLE database (EMPLOYEE, DEPARTMENT, PROJECT tables)

**Key Features:**
- 8 different tools demonstrating various parameter types
- 3 toolsets organizing tools by functional area
- Real-world SQL patterns for joins, aggregations, and filtering
- Complete parameter validation and security configuration

**File Location:** `tools/sample/employee-info.yaml`

---

### Source Configuration

```yaml
sources:
  ibmi-sample:
    host: ${DB2i_HOST}
    user: ${DB2i_USER}
    password: ${DB2i_PASS}
    port: 8076
    ignore-unauthorized: true
```

**What it does:** Defines a connection to the IBM i system using environment variables for credentials. This same source is reused by all 8 tools in the file.

---

### Tool 1: Basic String Parameter with Pattern Validation

**Tool:** `get_employee_details`

**Demonstrates:**
- String parameters with regex pattern validation
- Table joins (EMPLOYEE → DEPARTMENT → EMPLOYEE for manager)
- Security annotations and metadata

```yaml
get_employee_details:
  source: ibmi-sample
  description: Retrieve detailed information about an employee including department and manager
  statement: |
    SELECT
      E.EMPNO,
      E.FIRSTNME,
      E.MIDINIT,
      E.LASTNAME,
      E.JOB,
      E.HIREDATE,
      E.SALARY,
      E.BONUS,
      E.WORKDEPT,
      D.DEPTNAME,
      D.LOCATION,
      M.FIRSTNME AS MGR_FIRSTNME,
      M.LASTNAME AS MGR_LASTNAME
    FROM SAMPLE.EMPLOYEE E
    LEFT JOIN SAMPLE.DEPARTMENT D ON E.WORKDEPT = D.DEPTNO
    LEFT JOIN SAMPLE.EMPLOYEE M ON D.MGRNO = M.EMPNO
    WHERE E.EMPNO = :employee_id
  parameters:
    - name: employee_id
      type: string
      description: "Employee ID (e.g., '000010') - Must be 6 digits"
      required: true
      pattern: "^[0-9]{6}$"
```

**Key Learning Points:**
- The `pattern` constraint enforces a 6-digit format
- Description includes an example value to guide the LLM
- SQL uses LEFT JOINs to handle cases where department or manager might not exist
- The self-join on EMPLOYEE (aliased as M) retrieves manager information

**MCP Tool Call Example:**
```json
{
  "method": "tools/call",
  "params": {
    "name": "get_employee_details",
    "arguments": {
      "employee_id": "000010"
    }
  }
}
```

---

### Tool 2: String Enum Parameter

**Tool:** `find_employees_by_department`

**Demonstrates:**
- String enum parameters for controlled value selection
- Simple filtering with ORDER BY

```yaml
find_employees_by_department:
  source: ibmi-sample
  description: List employees in a specific department
  statement: |
    SELECT
      E.EMPNO,
      E.FIRSTNME,
      E.MIDINIT,
      E.LASTNAME,
      E.JOB,
      E.HIREDATE,
      E.SALARY
    FROM SAMPLE.EMPLOYEE E
    WHERE E.WORKDEPT = :department_id
    ORDER BY E.LASTNAME, E.FIRSTNME
  parameters:
    - name: department_id
      type: string
      description: "Department ID - Select from predefined departments"
      required: true
      enum: ["A00", "B01", "C01", "D01", "E01"]
```

**Key Learning Points:**
- `enum` restricts input to valid department codes
- The description is automatically enhanced: "Must be one of: 'A00', 'B01', 'C01', 'D01', 'E01'"
- This prevents invalid department queries and provides autocomplete-like guidance to the LLM

**MCP Tool Call Example:**
```json
{
  "method": "tools/call",
  "params": {
    "name": "find_employees_by_department",
    "arguments": {
      "department_id": "A00"
    }
  }
}
```

---

### Tool 3: Another String Enum (Job Titles)

**Tool:** `find_employees_by_job`

**Demonstrates:**
- String enum for job title filtering
- Multi-table joins for richer output

```yaml
find_employees_by_job:
  source: ibmi-sample
  description: Find employees with a specific job title
  statement: |
    SELECT
      E.EMPNO,
      E.FIRSTNME,
      E.MIDINIT,
      E.LASTNAME,
      E.WORKDEPT,
      D.DEPTNAME,
      E.HIREDATE,
      E.SALARY
    FROM SAMPLE.EMPLOYEE E
    LEFT JOIN SAMPLE.DEPARTMENT D ON E.WORKDEPT = D.DEPTNO
    WHERE E.JOB = :job_title
    ORDER BY E.LASTNAME, E.FIRSTNME
  parameters:
    - name: job_title
      type: string
      description: "Job title - Select from common job titles"
      required: true
      enum: ["MANAGER", "ANALYST", "DESIGNER", "CLERK", "SALESREP", "PRES"]
```

**Key Learning Points:**
- Similar to department filtering but for job titles
- Demonstrates reusable pattern for categorical data
- JOIN with DEPARTMENT enriches the result with department names

---

### Tool 4: Boolean Parameter

**Tool:** `get_employee_projects`

**Demonstrates:**
- Boolean parameters for feature toggles
- Complex multi-table joins (4 tables)
- Conditional filtering based on boolean value

```yaml
get_employee_projects:
  source: ibmi-sample
  description: List projects an employee is working on
  statement: |
    SELECT
      P.PROJNO,
      P.PROJNAME,
      A.ACTNO,
      A.ACTDESC,
      EPA.EMSTDATE AS START_DATE,
      EPA.EMENDATE AS END_DATE,
      EPA.EMPTIME
    FROM SAMPLE.EMPPROJACT EPA
    JOIN SAMPLE.PROJECT P ON EPA.PROJNO = P.PROJNO
    JOIN SAMPLE.PROJACT PA ON EPA.PROJNO = PA.PROJNO AND EPA.ACTNO = PA.ACTNO
    JOIN SAMPLE.ACT A ON EPA.ACTNO = A.ACTNO
    WHERE EPA.EMPNO = :employee_id
    AND (:include_completed = 1 OR EPA.EMENDATE IS NULL)
    ORDER BY EPA.EMSTDATE DESC
  parameters:
    - name: employee_id
      type: string
      description: "Employee ID (e.g., '000010') - Must be 6 digits"
      required: true
      pattern: "^[0-9]{6}$"
    - name: include_completed
      type: boolean
      description: "Include completed projects (true) or only active projects (false)"
      default: true
```

**Key Learning Points:**
- Boolean parameters naturally map to `true`/`false` in SQL (converted to 1/0)
- The SQL condition `(:include_completed = 1 OR EPA.EMENDATE IS NULL)` filters active projects when false
- Default value of `true` makes the parameter optional
- Combines string pattern validation with boolean flag

**Usage Examples:**
```json
// Get all projects (completed and active)
{
  "method": "tools/call",
  "params": {
    "name": "get_employee_projects",
    "arguments": {
      "employee_id": "000010",
      "include_completed": true
    },
  }
}

// Get only active projects
{
  "method": "tools/call",
  "params": {
    "name": "get_employee_projects",
    "arguments": {
      "employee_id": "000010",
      "include_completed": false
    },
  }
}
```

---

### Tool 5: Integer Parameters with Optional Filtering

**Tool:** `get_department_salary_stats`

**Demonstrates:**
- Multiple optional integer parameters
- Default values and special values (*ALL pattern)
- Integer range constraints (min/max)
- SQL aggregation functions

```yaml
get_department_salary_stats:
  source: ibmi-sample
  description: Salary statistics by department with optional salary range filter
  statement: |
    SELECT
      D.DEPTNO,
      D.DEPTNAME,
      COUNT(E.EMPNO) AS EMPLOYEE_COUNT,
      AVG(E.SALARY) AS AVG_SALARY,
      MIN(E.SALARY) AS MIN_SALARY,
      MAX(E.SALARY) AS MAX_SALARY,
      SUM(E.SALARY) AS TOTAL_SALARY
    FROM SAMPLE.DEPARTMENT D
    LEFT JOIN SAMPLE.EMPLOYEE E ON D.DEPTNO = E.WORKDEPT
    WHERE (D.DEPTNO = :department_id OR :department_id = '*ALL')
    AND (E.SALARY >= :min_salary OR :min_salary IS NULL)
    AND (E.SALARY <= :max_salary OR :max_salary IS NULL)
    GROUP BY D.DEPTNO, D.DEPTNAME
    ORDER BY D.DEPTNO
  parameters:
    - name: department_id
      type: string
      description: "Department ID (e.g., 'A00') or '*ALL' for all departments"
      default: "*ALL"
    - name: min_salary
      type: integer
      description: "Minimum salary filter (required)"
      min: 0
      max: 100000
      default: 0
    - name: max_salary
      type: integer
      description: "Maximum salary filter (required)"
      min: 0
      max: 100000
      default: 100000
```

**Key Learning Points:**
- Integer constraints (`min: 0`, `max: 100000`) prevent invalid salary ranges
- GROUP BY with aggregations provides statistical summaries
- No `required: false` needed when parameter has a default value (`deptartment_id`)

**Usage Examples:**
```json
// All departments, no salary filter
{
  "method": "tools/call",
  "params": {
    "name": "get_department_salary_stats",
    "arguments": {
      "department_id": "*ALL",
      "min_salary": 0,
      "max_salary": 100000
    },
  }
}

// Specific department with salary range
{
  "method": "tools/call",
  "params": {
    "name": "get_department_salary_stats",
    "arguments": {
      "department_id": "A00",
      "min_salary": 20000,
      "max_salary": 40000
    },
  }
}
```

---

### Tool 6: Array Parameter (In Theory)

> ⚠️ This is not directly supported in IBM i SQL but shown here for illustrative purposes, eventually could be implemented with table functions, temporary tables, or other workarounds.

**Tool:** `find_project_team_members`

**Demonstrates:**
- Array parameters with string items
- Array length constraints
- SQL IN clause with array parameter

```yaml
find_project_team_members:
  source: ibmi-sample
  description: Find all employees working on specific projects
  statement: |
    SELECT
      E.EMPNO,
      E.FIRSTNME,
      E.MIDINIT,
      E.LASTNAME,
      E.JOB,
      E.WORKDEPT,
      D.DEPTNAME,
      EPA.PROJNO,
      EPA.EMSTDATE AS PROJECT_START_DATE,
      EPA.EMENDATE AS PROJECT_END_DATE,
      EPA.EMPTIME AS TIME_ALLOCATION
    FROM SAMPLE.EMPPROJACT EPA
    JOIN SAMPLE.EMPLOYEE E ON EPA.EMPNO = E.EMPNO
    LEFT JOIN SAMPLE.DEPARTMENT D ON E.WORKDEPT = D.DEPTNO
    WHERE EPA.PROJNO IN (:project_ids)
    ORDER BY EPA.PROJNO, E.LASTNAME, E.FIRSTNME
  parameters:
    - name: project_ids
      type: array
      itemType: string
      description: "List of project IDs to search for (e.g., ['MA2100', 'AD3100'])"
      required: true
      minLength: 1
      maxLength: 10
```

**Key Learning Points:**
- `itemType: string` specifies that array contains strings
- `minLength: 1` ensures at least one project ID is provided
- `maxLength: 10` prevents overly broad queries
- Array parameters are automatically expanded: `IN (:project_ids)` becomes `IN (?, ?, ?)`
- Description includes example array format to guide the LLM

**MCP Tool Call Example:**
```json
{
  "method": "tools/call",
  "params": {
    "name": "find_project_team_members",
    "arguments": {
      "project_ids": ["MA2100", "AD3100", "PL2100"]
    }
  }
}
```

---

### Tool 7: Float Parameter

**Tool:** `calculate_employee_bonus`

**Demonstrates:**
- Float parameters for decimal calculations
- Float range constraints
- Mathematical operations in SQL

```yaml
calculate_employee_bonus:
  source: ibmi-sample
  description: Calculate potential bonus for an employee based on performance rating and salary
  statement: |
    SELECT
      E.EMPNO,
      E.FIRSTNME,
      E.LASTNAME,
      E.SALARY,
      E.SALARY * :performance_multiplier AS CALCULATED_BONUS
    FROM SAMPLE.EMPLOYEE E
    WHERE E.EMPNO = :employee_id
  parameters:
    - name: employee_id
      type: string
      description: "Employee ID (e.g., '000010')"
      required: true
      pattern: "^[0-9]{6}$"
    - name: performance_multiplier
      type: float
      description: "Performance rating multiplier (0.0-0.3)"
      required: true
      min: 0.0
      max: 0.3
      default: 0.1
```

**Key Learning Points:**
- Float type allows decimal values (0.1, 0.15, 0.25, etc.)
- Range constraints (`min: 0.0`, `max: 0.3`) limit the multiplier to 0-30%
- SQL arithmetic: `E.SALARY * :performance_multiplier` calculates the bonus
- Combining float with string pattern validation for multi-parameter tools

**Usage Examples:**
```json
// 10% bonus (default)
{
  "method": "tools/call",
  "params": {
    "name": "calculate_employee_bonus",
    "arguments": {
      "employee_id": "000010",
      "performance_multiplier": 0.1
    },
  }
}

// 25% bonus
{
  "method": "tools/call",
  "params": {
    "name": "calculate_employee_bonus",
    "arguments": {
      "employee_id": "000010",
      "performance_multiplier": 0.25
    },
    "_meta": {
      "progressToken": 3
    }
  }
}
```

---

### Tool 8: Pagination with Multiple Integer Parameters

**Tool:** `search_employees`

**Demonstrates:**
- Multiple integer parameters for pagination
- String parameter with minimum length
- SQL LIMIT/OFFSET for pagination
- Case-insensitive partial matching

```yaml
search_employees:
  source: ibmi-sample
  description: Search for employees by name with pagination
  statement: |
    SELECT
      E.EMPNO,
      E.FIRSTNME,
      E.MIDINIT,
      E.LASTNAME,
      E.JOB,
      E.WORKDEPT,
      D.DEPTNAME
    FROM SAMPLE.EMPLOYEE E
    LEFT JOIN SAMPLE.DEPARTMENT D ON E.WORKDEPT = D.DEPTNO
    WHERE UPPER(E.FIRSTNME) LIKE UPPER('%' || :name_search || '%')
    OR UPPER(E.LASTNAME) LIKE UPPER('%' || :name_search || '%')
    ORDER BY E.LASTNAME, E.FIRSTNME
    LIMIT :page_size OFFSET (:page_number - 1) * :page_size
  parameters:
    - name: name_search
      type: string
      description: "Name to search for (partial match)"
      required: true
      minLength: 2
    - name: page_size
      type: integer
      description: "Number of results per page"
      default: 10
      min: 1
      max: 100
    - name: page_number
      type: integer
      description: "Page number (starting from 1)"
      default: 1
      min: 1
```

**Key Learning Points:**
- `minLength: 2` prevents single-character searches that return too many results
- LIMIT/OFFSET pagination pattern: `LIMIT :page_size OFFSET (:page_number - 1) * :page_size`
- Case-insensitive search: `UPPER(column) LIKE UPPER(pattern)`
- Partial matching with `'%' || :name_search || '%'`
- Multiple integer parameters with sensible defaults and constraints

**Usage Examples:**
```json
// First page of results
{
  "method": "tools/call",
  "params": {
    "name": "search_employees",
    "arguments": {
      "name_search": "Smith",
      "page_size": 10,
      "page_number": 1
    },
  }
}

// Second page with custom page size
{
  "method": "tools/call",
  "params": {
    "name": "search_employees",
    "arguments": {
      "name_search": "JO",
      "page_size": 25,
      "page_number": 2
    },
  }
}
```

---

### Toolset Organization

The file defines 3 toolsets to organize the 8 tools by functional area:

```yaml
toolsets:
  employee_information:
    title: "Employee Information"
    description: "Tools for retrieving and analyzing employee data"
    tools:
      - get_employee_details
      - find_employees_by_department
      - find_employees_by_job
      - search_employees

  project_management:
    title: "Project Management"
    description: "Tools for managing project assignments and team members"
    tools:
      - get_employee_projects
      - find_project_team_members

  salary_analysis:
    title: "Salary Analysis"
    description: "Tools for analyzing salary data across departments"
    tools:
      - get_department_salary_stats
      - calculate_employee_bonus
```

**Key Learning Points:**
- Toolsets group related tools for easier discovery and loading
- Each toolset has a title and description for human readability
- Tools can be loaded by toolset: `--toolsets employee_information,project_management`
- Organizational structure doesn't affect tool functionality, only discoverability

---

### Running the Example

**List available toolsets:**
```bash
npx ibmi-mcp-server --list-toolsets --tools tools/sample/employee-info.yaml
```

**Start server with specific toolsets:**
```bash
# Load only employee information tools
npx ibmi-mcp-server --tools tools/sample/employee-info.yaml --toolsets employee_information

# Load multiple toolsets
npx ibmi-mcp-server --tools tools/sample/employee-info.yaml --toolsets employee_information,salary_analysis

# Load entire directory (all sample tools)
npx ibmi-mcp-server --tools tools/sample
```

---

### Parameter Type Summary from This Example

| Tool | String | Integer | Float | Boolean | Array |
|------|--------|---------|-------|---------|-------|
| `get_employee_details` | ✅ (pattern) | | | | |
| `find_employees_by_department` | ✅ (enum) | | | | |
| `find_employees_by_job` | ✅ (enum) | | | | |
| `get_employee_projects` | ✅ (pattern) | | | ✅ | |
| `get_department_salary_stats` | ✅ (default) | ✅ (optional) | | | |
| `find_project_team_members` | | | | | ✅ |
| `calculate_employee_bonus` | ✅ (pattern) | | ✅ | | |
| `search_employees` | ✅ (minLength) | ✅ (pagination) | | | |

This file serves as a comprehensive reference implementation demonstrating all parameter types, validation patterns, and SQL techniques for building production-ready IBM i MCP tools.




