# IBM i Agent Architecture

A simplified, type-safe system for building and running IBM i agents powered by Agno.

## Overview

The agent system consists of four key components:

```
┌─────────────────┐
│  AgentRunConfig │  Single configuration object
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  AgentBuilder   │  Fluent API for agent creation
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Agent (Agno)   │  Fully configured agent instance
└─────────────────┘
```

## Quick Start

### Creating a New Agent

**1. Add Agent ID**

```python
# agents/agent_ids.py
class AgentID(str, Enum):
    IBMI_PERFORMANCE_MONITOR = "ibmi-performance-monitor"
    YOUR_NEW_AGENT = "your-agent-id"  # Add this
```

**2. Create Agent Factory**

```python
# agents/ibmi_agents.py
from agents.config import AgentRunConfig
from agents.builder import AgentBuilder
from agents.registry import register_agent, AgentMetadata

@register_agent(
    AgentMetadata(
        id="your-agent-id",
        name="Your Agent Name",
        description="Brief description of what it does",
        category="ibmi",
        tags=["tag1", "tag2"],
    )
)
def get_your_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    """Create your specialized agent."""
    return (
        AgentBuilder(AgentID.YOUR_NEW_AGENT, "Your Agent Name")
        .with_description("""
            You are a specialized IBM i assistant that helps with...
        """)
        .with_instructions("""
            Follow these steps:
            1. Do this...
            2. Then do that...
        """)
        .with_toolsets("performance", "sysadmin_search")
        .build(config)
    )
```

**3. Run Your Agent**

```bash
python cli.py --agent your-agent-id
```

Done! Your agent is automatically registered and available in the CLI.

## Core Components

### 1. AgentRunConfig

Single configuration object that replaces multiple parameters.

```python
from agents.config import AgentRunConfig

# Basic configuration
config = AgentRunConfig(
    model="openai:gpt-4o",
    debug_mode=False,
    enable_reasoning=True,
)

# Advanced configuration
config = AgentRunConfig(
    model="watsonx:llama-3-3-70b-instruct",
    debug_mode=True,
    enable_reasoning=False,
    mcp_url="http://custom-server:8000",
    transport="streamable-http",
    debug_filtering=True,
)

# With YAML config file
from infra.config_manager import AgentConfigManager

config = AgentRunConfig(
    model="openai:gpt-4o",
    config_manager=AgentConfigManager("infra/config.yaml")
)
```

**Configuration Precedence:**
1. CLI arguments (highest priority)
2. YAML config file (via config_manager)
3. AgentRunConfig defaults
4. Builder defaults (lowest priority)

### 2. AgentBuilder

Fluent API for constructing agents with minimal boilerplate.

```python
from agents.builder import AgentBuilder
from agents.agent_ids import AgentID

agent = (
    AgentBuilder(AgentID.IBMI_PERFORMANCE_MONITOR, "Performance Monitor")
    .with_description("System performance monitoring agent")
    .with_instructions("Monitor CPU, memory, and I/O...")
    .with_toolsets("performance")  # MCP toolsets
    .build(config)
)
```

**Available Methods:**

| Method | Purpose | Example |
|--------|---------|---------|
| `.with_description(str)` | Set agent description | `.with_description("Performance monitoring...")` |
| `.with_instructions(str)` | Set detailed instructions | `.with_instructions("1. Check CPU\n2. Check memory...")` |
| `.with_toolsets(*str)` | Add MCP tool filters | `.with_toolsets("performance", "sysadmin")` |
| `.with_additional_tools(*Tool)` | Add custom Agno tools | `.with_additional_tools(MyCustomTool())` |
| `.with_agent_kwargs(**kwargs)` | Override Agent() params | `.with_agent_kwargs(retries=5, num_history_runs=10)` |
| `.build(config)` | Create Agent instance | `.build(config)` |

### 3. Registry System

Automatic agent discovery via decorator pattern.

```python
from agents.registry import register_agent, AgentMetadata

@register_agent(
    AgentMetadata(
        id="my-agent",           # CLI identifier
        name="My Agent",         # Human-readable name
        description="Does X",   # Brief description
        category="ibmi",        # Category for grouping
        tags=["tag1", "tag2"],  # Optional tags
    )
)
def get_my_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    """Factory function that creates the agent."""
    return AgentBuilder(...).build(config)
```

**Registry automatically:**
- ✅ Validates metadata (ID format, required fields)
- ✅ Prevents duplicate registrations
- ✅ Makes agents available in CLI
- ✅ Enables filtering by category/tags

## Configuration Management

### Environment Variables

Storage configuration (PostgreSQL vs SQLite):

```bash
# Use SQLite for local development
export USE_SQLITE=true
export SQLITE_DB_PATH=/path/to/agents.db

# Use PostgreSQL for production (default)
unset USE_SQLITE
export DATABASE_URL=postgresql://user:pass@host:5432/db
```

MCP Server connection:

```bash
export MCP_URL=http://127.0.0.1:3010/mcp
export MCP_TRANSPORT=streamable-http
```

### YAML Configuration

Create `infra/config.yaml`:

```yaml
# Model providers
openai:
  api_key: ${OPENAI_API_KEY}

watsonx:
  api_key: ${WATSONX_API_KEY}
  project_id: ${WATSONX_PROJECT_ID}
  url: https://us-south.ml.cloud.ibm.com

# Agent-specific configs
agents:
  default_model: "openai:gpt-4o"

  ibmi-performance-monitor:
    model: "watsonx:llama-3-3-70b-instruct"
    enable_reasoning: true
    debug_mode: false

  ibmi-sysadmin-search:
    enable_reasoning: false
    debug_mode: true
```

**Use in code:**

```python
from agents.config import AgentRunConfig
from infra.config_manager import AgentConfigManager

config = AgentRunConfig(
    config_manager=AgentConfigManager("infra/config.yaml")
)

agent = get_performance_agent(config)
# Agent will use watsonx:llama-3-3-70b-instruct from config.yaml
```

## CLI Usage

### Basic Commands

```bash
# List available agents
python cli.py --list-agents

# Run an agent with defaults
python cli.py --agent performance

# Run with different model
python cli.py --agent performance --model-id watsonx:llama-3-3-70b-instruct
```

### Advanced Options

```bash
# Disable reasoning tools
python cli.py --agent performance --disable-reasoning

# Enable debug mode
python cli.py --agent performance --debug --debug-filtering

# Custom MCP server
python cli.py --agent performance --mcp-url http://localhost:8000

# Use config file
python cli.py --agent performance --config-file custom-config.yaml

# Combine multiple options
python cli.py --agent performance \
  --model-id watsonx:llama-3-3-70b-instruct \
  --disable-reasoning \
  --debug \
  --stream
```

### All CLI Flags

| Flag | Purpose | Example |
|------|---------|---------|
| `--agent <id>` | Select agent to run | `--agent performance` |
| `--model-id <spec>` | Override model | `--model-id openai:gpt-4o` |
| `--debug` | Enable debug mode | `--debug` |
| `--stream` | Stream responses | `--stream` |
| `--enable-reasoning` | Enable reasoning tools (default) | `--enable-reasoning` |
| `--disable-reasoning` | Disable reasoning tools | `--disable-reasoning` |
| `--debug-filtering` | Debug tool filtering | `--debug-filtering` |
| `--mcp-url <url>` | Override MCP server URL | `--mcp-url http://localhost:8000` |
| `--mcp-transport <type>` | Override MCP transport | `--mcp-transport sse` |
| `--config-file <path>` | Load YAML config | `--config-file config.yaml` |

## Advanced Patterns

### Custom Tools

Add custom Agno tools beyond MCP tools:

```python
from my_tools import CustomDatabaseTool

def get_advanced_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    return (
        AgentBuilder(AgentID.ADVANCED_AGENT, "Advanced Agent")
        .with_description("Agent with custom capabilities")
        .with_instructions("Use custom tools when needed...")
        .with_toolsets("performance")  # MCP tools
        .with_additional_tools(
            CustomDatabaseTool(),  # Custom tool
        )
        .build(config)
    )
```

### Override Agent() Parameters

Customize Agno Agent behavior:

```python
def get_high_memory_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    return (
        AgentBuilder(AgentID.HIGH_MEMORY_AGENT, "High Memory Agent")
        .with_description("Agent that needs more context")
        .with_instructions("Remember lots of history...")
        .with_toolsets("performance")
        .with_agent_kwargs(
            num_history_runs=10,      # Default: 3
            num_history_sessions=5,   # Default: 2
            retries=5,                # Default: 3
            markdown=False,           # Default: True
        )
        .build(config)
    )
```

**Available Agent() overrides** (see `agents/builder.py` for full list):
- `num_history_runs` - Number of previous runs to remember
- `num_history_sessions` - Number of sessions to search
- `retries` - Number of retry attempts
- `markdown` - Use markdown formatting
- `enable_agentic_memory` - Enable memory personalization
- And any other Agno `Agent()` parameter

### Multiple MCP Toolsets

Combine multiple toolset filters:

```python
def get_comprehensive_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    return (
        AgentBuilder(AgentID.COMPREHENSIVE_AGENT, "Comprehensive Agent")
        .with_description("Agent with access to multiple toolsets")
        .with_instructions("Use performance AND search tools...")
        .with_toolsets(
            "performance",        # Performance monitoring tools
            "sysadmin_search",    # Search capabilities
            "sysadmin_browse",    # Browse capabilities
        )
        .build(config)
    )
```

## Available IBM i Agents

| Agent ID | Name | Description | Toolsets |
|----------|------|-------------|----------|
| `performance` | IBM i Performance Monitor | CPU, memory, I/O monitoring | performance |
| `sysadmin-discovery` | IBM i SysAdmin Discovery | High-level system discovery | sysadmin_discovery |
| `sysadmin-browse` | IBM i SysAdmin Browser | Detailed service browsing | sysadmin_browse |
| `sysadmin-search` | IBM i SysAdmin Search | Service search and lookup | sysadmin_search |

## Architecture Benefits

### Before (Old Pattern)

```python
def get_agent(
    model="openai:gpt-4o",
    mcp_url=None,
    transport=None,
    debug_filtering=False,
    debug_mode=False,
    enable_reasoning=True,
    config_manager=None,
):
    # ~150 lines of boilerplate
    model, debug_mode, enable_reasoning = apply_agent_config(...)
    tools = FilteredMCPTools(...)
    if enable_reasoning:
        tools.append(ReasoningTools(...))
    return create_ibmi_agent(...)
```

### After (New Pattern)

```python
def get_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    # ~30 lines total
    return (
        AgentBuilder(AgentID.MY_AGENT, "My Agent")
        .with_description("...")
        .with_instructions("...")
        .with_toolsets("performance")
        .build(config)
    )
```

**Improvements:**
- ✅ **70% less code** per agent
- ✅ **Type-safe** configuration
- ✅ **Future-proof** - **kwargs pattern adapts to Agno changes
- ✅ **Self-documenting** - Clear builder methods
- ✅ **Testable** - Easy to mock AgentRunConfig
- ✅ **CLI integration** - All options accessible from command line

## Troubleshooting

### Agent not appearing in --list-agents

**Check:**
1. Agent decorated with `@register_agent()`
2. Agent ID added to `AgentID` enum
3. Agent imported in `agents/ibmi_agents.py`
4. No duplicate agent IDs

### Tools not working

**Check:**
1. MCP server running: `curl http://127.0.0.1:3010/mcp`
2. Toolset name matches MCP server annotations
3. Use `--debug-filtering` to see tool filtering logs

### Config file not loading

**Check:**
1. File path correct: `--config-file infra/config.yaml`
2. YAML syntax valid
3. Agent ID in config matches registered ID
4. Use `--debug` to see config loading logs

## Testing Agents

### Unit Testing

```python
from agents.config import AgentRunConfig
from agents.ibmi_agents import get_performance_agent

def test_agent_creation():
    config = AgentRunConfig(model="openai:gpt-4o", debug_mode=True)
    agent = get_performance_agent(config)

    assert agent is not None
    assert agent.name == "IBM i Performance Monitor"
    assert agent.debug_mode == True
```

### Interactive Testing

```bash
# Test with defaults
python cli.py --agent performance

# Test with debug enabled
python cli.py --agent performance --debug --debug-filtering

# Test with custom config
python cli.py --agent performance --config-file test-config.yaml
```

### Testing in Python

```python
from agents.config import AgentRunConfig
from agents.ibmi_agents import get_performance_agent

# Create agent
config = AgentRunConfig(model="openai:gpt-4o")
agent = get_performance_agent(config)

# Run query
response = agent.run("What is the current CPU utilization?")
print(response.content)

# Interactive mode
agent.cli_app(markdown=True, stream=True)
```

## Reference

- **Template**: `agents/template.py` - Comprehensive example for new agents
- **Config**: `agents/config.py` - AgentRunConfig dataclass
- **Builder**: `agents/builder.py` - AgentBuilder implementation
- **Registry**: `agents/registry.py` - Registration system
- **Examples**: `agents/ibmi_agents.py` - All IBM i agent implementations
