# Naming Conventions

## Description
Consistent naming conventions ensure that IBM i MCP tools are intuitive, discoverable, and maintainable. These conventions help users understand tool purposes and relationships without needing to read detailed documentation.

## Requirements
- Tool names must use lowercase snake_case (words separated by underscores)
- Tool names should be verb-noun pairs that clearly describe the action (e.g., `find_active_jobs`, `get_system_status`)
- Parameter names must use lowercase snake_case
- Source names should be descriptive of the connection purpose (e.g., `ibmi_prod`, `ibmi_test`)
- Toolset names should use lowercase snake_case and represent functional categories
- Annotations for domain and category should use lowercase with hyphens for multi-word values

## Examples

### Correct Tool Names
```yaml
tools:
  find_active_jobs:
    # ...
  get_system_status:
    # ...
  list_user_profiles:
    # ...
  analyze_disk_usage:
    # ...
```

### Incorrect Tool Names
```yaml
tools:
  ActiveJobs:     # Incorrect: Uses PascalCase instead of snake_case
    # ...
  get-system-status:  # Incorrect: Uses hyphens instead of underscores
    # ...
  listUserProfiles:   # Incorrect: Uses camelCase instead of snake_case
    # ...
  ANALYZE_DISK_USAGE: # Incorrect: Uses uppercase instead of lowercase
    # ...
```

### Correct Parameter Names
```yaml
parameters:
  - name: job_name
    # ...
  - name: user_profile
    # ...
  - name: days_to_analyze
    # ...
```

### Incorrect Parameter Names
```yaml
parameters:
  - name: JobName      # Incorrect: Uses PascalCase instead of snake_case
    # ...
  - name: user-profile # Incorrect: Uses hyphens instead of underscores
    # ...
  - name: daysToAnalyze # Incorrect: Uses camelCase instead of snake_case
    # ...
```

### Correct Toolset Names
```yaml
toolsets:
  job_management:
    # ...
  system_monitoring:
    # ...
  user_administration:
    # ...
```

### Correct Annotations
```yaml
annotations:
  domain: "system"
  category: "job-management"
  readOnlyHint: true
```

## Naming Patterns by Purpose

### Query Tools
- Use verbs like `find`, `get`, `list`, `search`, `query`
- Examples: `find_active_jobs`, `list_user_profiles`, `get_system_status`

### Analysis Tools
- Use verbs like `analyze`, `calculate`, `summarize`, `evaluate`
- Examples: `analyze_disk_usage`, `calculate_system_load`, `summarize_job_metrics`

### Monitoring Tools
- Use verbs like `monitor`, `track`, `watch`
- Examples: `monitor_job_queues`, `track_system_performance`, `watch_message_queues`

### Administrative Tools
- Use verbs like `manage`, `configure`, `control`
- Examples: `manage_user_profiles`, `configure_system_values`, `control_subsystems`

## Related Schema Elements
- Tool names (keys in the `tools` object)
- Parameter names (`name` property in parameters array)
- Toolset names (keys in the `toolsets` object)
- Annotation values (`domain` and `category` properties)