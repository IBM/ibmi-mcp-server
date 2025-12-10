# Google ADK Integration for IBM i MCP Tools

This module provides filtered MCP (Model Context Protocol) tool loading with annotation-based filtering for Google ADK agents. It enables seamless integration between IBM i systems and Google ADK agents with powerful filtering capabilities.

## Features

- 🔌 **Dual Transport Support** - Both HTTP and stdio transports
- 🎯 **Annotation-Based Filtering** - Filter tools by toolsets, safety hints, and custom criteria
- 🛡️ **Safety Controls** - Built-in filters for read-only, non-destructive, and closed-world tools
- 🔍 **Debug Mode** - Verbose logging for troubleshooting

## Installation

The module is part of the `ibmi-agent-sdk` package:

```bash
# Using uv (recommended)
uv add ibmi-agent-sdk

# Using pip
pip install ibmi-agent-sdk
```

## Quick Start

### Basic Usage - HTTP Transport

```python
from ibmi_agent_sdk.google_adk import load_toolset_tools

# Load performance monitoring tools
toolset = load_toolset_tools("performance")

# Get the tools (this is async)
import asyncio
tools = asyncio.run(toolset.get_tools())
print(f"Loaded {len(tools)} tools")
```

### Using Stdio Transport

```python
from ibmi_agent_sdk.google_adk import load_toolset_tools

toolset = load_toolset_tools(
    "performance",
    transport="stdio",
    command="npx",
    args=["ibmi-mcp-server"],
    env={
        "DB2i_HOST": "your-host.com",
        "DB2i_USER": "username",
        "DB2i_PASSWORD": "password",
        "DB2i_PORT": "8076"
    }
)
```

## Available Functions

### Main Loading Function

#### `load_filtered_mcp_tools()`
The core function with maximum flexibility:

```python
toolset = load_filtered_mcp_tools(
    annotation_filters={"toolsets": ["performance"]},
    transport="streamable_http",  # or "stdio"
    url="http://127.0.0.1:3010/mcp",
    token="your-token",  # or from IBMI_MCP_ACCESS_TOKEN env var
    debug=True
)
```

### Convenience Functions

#### `load_toolset_tools(toolsets, ...)`
Filter by toolset annotation:

```python
# Single toolset
toolset = load_toolset_tools("performance")

# Multiple toolsets
toolset = load_toolset_tools(["performance", "sys_admin"])
```

#### `load_readonly_tools(...)`
Load only read-only tools:

```python
toolset = load_readonly_tools()
```

#### `load_non_destructive_tools(...)`
Load only non-destructive tools:

```python
toolset = load_non_destructive_tools()
```

#### `load_closed_world_tools(...)`
Load only closed-world tools:

```python
toolset = load_closed_world_tools()
```

#### `load_safe_tools(...)`
Load safe tools (read-only + non-destructive + closed-world):

```python
toolset = load_safe_tools()
```

## Filtering

### By Toolsets

```python
# Filter by specific toolsets
toolset = load_filtered_mcp_tools(
    annotation_filters={"toolsets": ["performance", "sys_admin"]}
)
```

### By Safety Annotations

```python
# Only read-only tools
toolset = load_filtered_mcp_tools(
    annotation_filters={"readOnlyHint": True}
)

# Non-destructive tools
toolset = load_filtered_mcp_tools(
    annotation_filters={"destructiveHint": False}
)

# Combine multiple filters (AND logic)
toolset = load_filtered_mcp_tools(
    annotation_filters={
        "toolsets": ["performance"],
        "readOnlyHint": True,
        "destructiveHint": False
    }
)
```

### Custom Filtering

```python
# Use a custom filter function
toolset = load_filtered_mcp_tools(
    custom_filter=lambda tool: "system" in tool.name.lower()
)
```

## Transport Configuration

### HTTP Transport (Default)

```python
toolset = load_filtered_mcp_tools(
    transport="streamable_http",
    url="http://127.0.0.1:3010/mcp",
    token="your-bearer-token"  # or set IBMI_MCP_ACCESS_TOKEN env var
)
```

### Stdio Transport

```python
toolset = load_filtered_mcp_tools(
    transport="stdio",
    command="npx",
    args=["ibmi-mcp-server"],
    env={
        "DB2i_HOST": "your-host.com",
        "DB2i_USER": "username",
        "DB2i_PASSWORD": "password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio"
    }
)
```

## Debug Mode

Enable verbose logging to see filtering details:

```python
toolset = load_toolset_tools(
    "performance",
    debug=True  # Enable verbose output
)
```

**Debug output includes:**
- Transport type and connection details
- Which tools are included (✓) or excluded (✗)
- Annotation values for excluded tools
- Total number of tools loaded
- Tool names and descriptions

Example output:
```
[FilteredMCPTools] Using streamable_http transport
[FilteredMCPTools] Connecting to http://127.0.0.1:3010/mcp
[ToolPredicate] ✓ Including system_status: toolsets=['performance']
[ToolPredicate] ✗ Excluding describe_object: toolsets=['sys_admin']
[FilteredMCPTools] McpToolset created successfully
[FilteredMCPTools] Loaded 15 tools
  - system_status: Overall system performance statistics
  - system_activity: Current system activity information
```

## Predicate Functions

For advanced use cases, create custom predicates:

```python
from ibmi_agent_sdk.google_adk import (
    toolset_filter_predicate,
    annotation_filter_predicate
)

# Create a toolset predicate
predicate = toolset_filter_predicate(["performance"], debug=True)

# Create a multi-annotation predicate
predicate = annotation_filter_predicate({
    "toolsets": ["performance"],
    "readOnlyHint": True
}, debug=True)

# Use with McpToolset directly
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset

toolset = McpToolset(
    connection_params=...,
    tool_filter=predicate
)
```

## Complete Example

```python
import asyncio
import os
from ibmi_agent_sdk.google_adk import load_safe_tools

# Set environment variable for authentication
os.environ["IBMI_MCP_ACCESS_TOKEN"] = "your-token"

# Load only safe tools (read-only, non-destructive, closed-world)
toolset = load_safe_tools(
    url="http://127.0.0.1:3010/mcp",
    debug=True
)

# Get the tools (toolset.get_tools() is async, so we need to run it)
tools = asyncio.run(toolset.get_tools())

print(f"\nLoaded {len(tools)} safe tools:")
for tool in tools:
    print(f"  - {tool.name}: {tool.description}")
```

## Environment Variables

- `IBMI_MCP_ACCESS_TOKEN` - Bearer token for HTTP authentication (required for streamable_http transport)

## Testing

Run the comprehensive test suite:

```bash
# Navigate to the package directory
cd agents/packages/ibmi-agent-sdk

# Run all tests
uv run pytest tests/test_google_adk_filtered_mcp_tools.py -v

# Run specific test class
uv run pytest tests/test_google_adk_filtered_mcp_tools.py::TestGetAnnotationValue -v

# Run with coverage
uv run pytest tests/test_google_adk_filtered_mcp_tools.py --cov=ibmi_agent_sdk.google_adk.filtered_mcp_tools
```

**Test Coverage:** 36 tests covering:
- Annotation extraction and matching
- Predicate creation and filtering
- Both transport types
- All convenience functions
- Error handling
- Integration scenarios

## API Reference

### Function Signatures

```python
async def load_filtered_mcp_tools(
    annotation_filters: Optional[Dict[str, Union[Any, List[Any], Callable]]] = None,
    custom_filter: Optional[Callable] = None,
    transport: Literal["streamable_http", "stdio"] = "streamable_http",
    url: Optional[str] = None,
    token: Optional[str] = None,
    command: Optional[str] = None,
    args: Optional[List[str]] = None,
    env: Optional[Dict[str, str]] = None,
    debug: bool = False,
) -> McpToolset

async def load_toolset_tools(
    toolsets: Union[str, List[str]],
    transport: Literal["streamable_http", "stdio"] = "streamable_http",
    url: Optional[str] = None,
    token: Optional[str] = None,
    command: Optional[str] = None,
    args: Optional[List[str]] = None,
    env: Optional[Dict[str, str]] = None,
    debug: bool = False,
) -> McpToolset

async def load_readonly_tools(...) -> McpToolset
async def load_non_destructive_tools(...) -> McpToolset
async def load_closed_world_tools(...) -> McpToolset
async def load_safe_tools(...) -> McpToolset
```

## Best Practices

1. **Use convenience functions** for common filtering patterns
2. **Enable debug mode** during development and troubleshooting
3. **Use safe_tools** for production environments when possible
4. **Store credentials** in environment variables, not in code
5. **Test filters** with debug mode before deploying

## Troubleshooting

### Missing Token Error
```
ValueError: Missing IBMI_MCP_ACCESS_TOKEN in environment variables
```
**Solution:** Set the `IBMI_MCP_ACCESS_TOKEN` environment variable or pass `token` parameter.

### Missing Command Error
```
ValueError: command parameter is required for stdio transport
```
**Solution:** Provide `command` parameter when using stdio transport.

### Import Errors
**Solution:** Ensure all dependencies are installed:
```bash
uv add google-adk openai ibm-watsonx-ai langchain-mcp-adapters agno mcp
```

## Contributing

When adding new features:
1. Update the main `filtered_mcp_tools.py` file
2. Add corresponding tests in `tests/test_google_adk_filtered_mcp_tools.py`
3. Update this README with usage examples
4. Ensure all tests pass: `uv run pytest tests/test_google_adk_filtered_mcp_tools.py -v`

## License

Part of the IBM i MCP Server project.