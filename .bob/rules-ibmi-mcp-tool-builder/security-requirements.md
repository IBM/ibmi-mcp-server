# Security Requirements

## Description
Security is a critical aspect of IBM i MCP tools. These requirements ensure that tools follow security best practices, protect sensitive data, and respect IBM i authority mechanisms.

## Requirements
- All tools must use parameter binding (`:param_name`) to prevent SQL injection
- Read-only operations should be the default (`readOnly: true` in security section)
- Large result sets must include row limits (e.g., `FETCH FIRST 100 ROWS ONLY`)
- Sensitive operations must be marked with appropriate security annotations
- Tools must respect IBM i object authorities and special authorities
- Destructive operations (DELETE, DROP, UPDATE) should be avoided or clearly marked

## Examples

### Correct Parameter Binding
```yaml
tools:
  find_user_data:
    statement: |
      SELECT * FROM user_data
      WHERE user_id = :user_id
      AND status = :status
    parameters:
      - name: user_id
        type: string
        description: "User identifier"
      - name: status
        type: string
        description: "Status filter"
        default: "ACTIVE"
```

### Incorrect Parameter Binding
```yaml
tools:
  find_user_data:
    statement: |
      SELECT * FROM user_data
      WHERE user_id = '${user_id}'  # Incorrect: String interpolation is vulnerable to SQL injection
      AND status = '${status}'      # Incorrect: Should use :status parameter binding
```

### Correct Security Configuration
```yaml
tools:
  list_active_jobs:
    # ... other configuration
    security:
      readOnly: true
      maxQueryLength: 5000
    annotations:
      readOnlyHint: true
      idempotentHint: true
```

### Correct Result Limiting
```yaml
tools:
  find_large_tables:
    statement: |
      SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_ROWS
      FROM QSYS2.SYSTABLES
      WHERE TABLE_TYPE = 'T'
      ORDER BY TABLE_ROWS DESC
      FETCH FIRST 100 ROWS ONLY  # Always limit large result sets
```

### Correct Destructive Operation Marking
```yaml
tools:
  clear_audit_history:
    # ... other configuration
    security:
      readOnly: false  # Explicitly mark as non-read-only
      audit: true      # Enable audit logging
    annotations:
      readOnlyHint: false
      destructiveHint: true  # Clearly mark as destructive
```

## Security Levels

### Level 1: Basic Security (Required)
- Parameter binding for all user inputs
- Read-only operations by default
- Result set limiting for large queries

### Level 2: Enhanced Security (Recommended)
- Explicit security configuration
- Appropriate annotations
- Authority checking
- Row-level security where applicable

### Level 3: Enterprise Security (For Sensitive Operations)
- Audit logging
- Special authority requirements
- Explicit scope limitations
- Detailed documentation of security implications

## Related Schema Elements
- `security` object in tool definition
- `annotations` object with security hints
- Parameter validation constraints
- SQL statement construction

## Security Checklist
- [ ] All user inputs use parameter binding
- [ ] Read-only operations are marked as such
- [ ] Large result sets include row limits
- [ ] Destructive operations are clearly marked
- [ ] Security annotations are accurate
- [ ] Authority requirements are documented
- [ ] Sensitive operations include audit logging