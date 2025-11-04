# Schema Validation Rules

## Description
These rules ensure that all YAML tool definitions conform to the IBM i MCP Server schema requirements. Proper schema validation prevents runtime errors and ensures consistent tool behavior.

## Requirements
- All YAML tool definitions must validate against the official schema at `server/src/ibmi-mcp-server/schemas/json/sql-tools-config.json`
- Required fields must be present and properly formatted
- Data types must match schema specifications
- Enumerations must use valid values from the schema
- All tools must be validated using `npm run validate -- --tools <file.yaml>` before submission

## Examples

### Correct
```yaml
sources:
  ibmi:
    host: ${DB2i_HOST}
    user: ${DB2i_USER}
    password: ${DB2i_PASS}
    port: 8076
    ignore-unauthorized: true

tools:
  find_active_jobs:
    source: ibmi
    description: "Find active jobs on the system matching specified criteria"
    statement: |
      SELECT * FROM TABLE(QSYS2.ACTIVE_JOB_INFO(
        JOB_NAME_FILTER => :job_name,
        JOB_USER_FILTER => :job_user,
        JOB_TYPE_FILTER => :job_type
      )) AS X
      ORDER BY CPU_TIME DESC
      FETCH FIRST 100 ROWS ONLY
    parameters:
      - name: job_name
        type: string
        description: "Job name filter (e.g., 'QZDASOINIT', '*ALL')"
        default: "*ALL"
      - name: job_user
        type: string
        description: "Job user filter (e.g., 'QUSER', '*ALL')"
        default: "*ALL"
      - name: job_type
        type: string
        description: "Job type filter (e.g., 'BATCH', 'INTER', '*ALL')"
        default: "*ALL"
    security:
      readOnly: true
    annotations:
      readOnlyHint: true
      idempotentHint: true
      domain: "system"
      category: "jobs"

toolsets:
  job_management:
    title: "Job Management Tools"
    description: "Tools for managing and monitoring jobs on IBM i"
    tools:
      - find_active_jobs
```

### Incorrect
```yaml
# Missing required fields
tools:
  find_active_jobs:
    # Missing source field (required)
    description: "Find active jobs"
    # Missing statement field (required)
    parameters:
      - name: job_name
        # Missing type field (required)
        description: "Job name filter"
```

## Related Schema Elements
- `sources` - Database connection configurations
- `tools` - Individual SQL tool definitions
- `parameters` - Parameter definitions with validation constraints
- `security` - Security configuration for tool execution
- `annotations` - Optional annotations for MCP clients
- `toolsets` - Toolset definitions for grouping related tools

## Validation Process
1. Use the JSON schema to validate your YAML configuration
2. Run `npm run validate -- --tools <file.yaml>` to check for schema compliance
3. Address any validation errors before submitting
4. Test tool execution to ensure proper functionality

## Common Validation Errors
- Missing required fields (`source`, `description`, `statement`)
- Invalid parameter types (must be one of: `string`, `boolean`, `integer`, `float`, `array`)
- Invalid security settings
- Incorrect enum values
- Malformed SQL statements