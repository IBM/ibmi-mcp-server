# IBM i MCP Agents: LangChain

AI agents for IBM i system administration and monitoring built with LangChain/LangGraph framework and Model Context Protocol (MCP) tools. This project provides intelligent agents that can analyze IBM i system performance, manage security, and assist with administrative tasks.

## What is this project?

The IBM i LangChain Agents project provides Python-based intelligent agents that leverage MCP tools to perform system administration tasks on IBM i systems. Built on LangGraph, these agents feature advanced capabilities like human-in-the-loop approval for security operations and persistent conversation memory.

### Key Features

- **Five Specialized Agents**: Purpose-built agents for different IBM i tasks
- **Multi-Model Support**: Works with OpenAI, Anthropic Claude, and local Ollama models
- **MCP Integration**: Connects to the IBM i MCP Server for system operations
- **Human-in-the-Loop**: Security operations require manual approval for write operations
- **Persistent Memory**: Agents maintain context across sessions using in-memory checkpointing
- **Rich Logging**: Detailed tool call and response logging for debugging
- **Interactive & Batch Modes**: CLI for interactive chat or automated testing

### Available Agents

1. **Performance Agent** - Monitor and analyze system performance metrics (CPU, memory, I/O) - 12 tools
2. **Discovery Agent** - High-level system discovery, inventory, and service summaries - 5 tools
3. **Browse Agent** - Detailed exploration of system services by category or schema - 4 tools
4. **Search Agent** - Find specific services, programs, or system resources - 5 tools
5. **Security Agent** - Security vulnerability assessment and remediation - 25 tools with human-in-the-loop

## Requirements

- **Python 3.13+** - The project requires Python 3.13 or newer
- **uv** - Python package manager for installing dependencies and managing virtual environments ([Install uv](https://astral.sh/uv/))
- **IBM i MCP Server** - Must be installed and running on your system
- **API Keys** - For your chosen LLM provider (OpenAI, Anthropic, or Ollama)

## Setup Guide

Follow these step-by-step instructions to set up and run the IBM i LangChain MCP Agents.

### Step 1: Install Prerequisites

**1.1 Install Python 3.13+**
```bash
# Check your Python version
python --version  # or python3 --version

# If you need to install Python 3.13+, visit:
# https://www.python.org/downloads/
```

**1.2 Install uv (Python package manager)**
```bash
# On macOS and Linux:
curl -LsSf https://astral.sh/uv/install.sh | sh

# On Windows (PowerShell):
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# Alternative: Install via pip
pip install uv
```

### Step 2: Set Up the IBM i MCP Server

Ensure you have the IBM i MCP Server installed and running.

> [!NOTE]
> **Follow the MCP Server installation guide →** [Quickstart Guide](../../../README.md#-quickstart)
> 
> **Configure the server →** [Server Configuration Guide](../../../README.md#-configuration)

**2.1 Install dependencies and build the server:**
```bash
cd ibmi-mcp-server
npm install
npm run build
```

**2.2 Start the MCP server:**
```bash
npm run dev
```

The server will start on `http://127.0.0.1:3010/mcp` by default.

**2.3 Verify the server is running:**
```bash
curl http://127.0.0.1:3010/mcp
```

Expected response:
```json
{"status":"ok","server":{"name":"ibmi-mcp-server","version":"1.9.1",...}}
```

### Step 3: Install Agent Dependencies

**3.1 Install the ibmi-agent-sdk package:**
```bash
cd agents/packages/ibmi-agent-sdk
uv pip install -e .
```

**3.2 Install the LangChain agents package:**
```bash
cd ../../frameworks/langchain
uv pip install -e .
```

### Step 4: Configure Environment Variables

Create a `.env` file in the `agents/frameworks/langchain` directory:

```bash
cd agents/frameworks/langchain
cp .env.example .env
```

**4.1 Edit the `.env` file with your configuration:**

```bash
# Choose your default model (Ollama recommended for local development)
DEFAULT_MODEL=ollama:llama3.2

# Add API keys only for providers you plan to use:

# OpenAI (for GPT-4, GPT-4o models)
OPENAI_API_KEY=

# Anthropic (for Claude models)
ANTHROPIC_API_KEY=

# MCP Server Configuration (usually defaults are fine)
MCP_URL=http://127.0.0.1:3010/mcp
MCP_TRANSPORT=streamable_http

# Logging (set to false for minimal output)
VERBOSE_LOGGING=true

# Security (enable human-in-the-loop for write operations)
ENABLE_HUMAN_IN_LOOP=true
```

**4.2 For Ollama (local models - no API key needed):**
```bash
# Install Ollama from: https://ollama.ai
# Pull a model:
ollama pull llama3.2
```

**Note:** You only need API keys for the providers you plan to use.

### Step 5: Verify Setup

Run a quick test to verify all agents can be created:

```bash
uv run src/ibmi_agents/agents/test_agents.py --quick
```

Expected output:
```
================================================================================
Quick Agent Creation Test
================================================================================
Model: ollama:llama3.2

Creating performance agent... ✅ IBM i Performance Monitor
Creating discovery agent... ✅ IBM i SysAdmin Discovery
Creating browse agent... ✅ IBM i SysAdmin Browser
Creating search agent... ✅ IBM i SysAdmin Search
Creating security agent... ✅ IBM i Security Operations
🔒 Human-in-the-loop enabled for 2 non-readonly tools:
   - repopulate_special_authority_detail
   - execute_impersonation_lockdown

────────────────────────────────────────────────────────────────────────────────
Result: 5/5 agents created successfully
================================================================================
```

## Usage Examples

### Quick Test (Verify Setup)
```bash
uv run src/ibmi_agents/agents/test_agents.py --quick
```

### Test Specific Agent
```bash
# Test performance agent with sample query
uv run src/ibmi_agents/agents/test_agents.py --agent performance

# Test with quiet mode (minimal output)
uv run src/ibmi_agents/agents/test_agents.py --agent performance --quiet
```

### Interactive Mode
```bash
# Chat interactively with an agent
uv run src/ibmi_agents/agents/test_agents.py --agent performance --interactive
```

Example session:
```
👤 You: What is my system status?
🤖 IBM i Performance Monitor: 

### Quick‑look snapshot

| Metric | Value | Why it matters |
|--------|-------|----------------|
| **Configured CPUs** | 3 | The number of logical CPUs the system is allowed to use. |
| **Average CPU utilization** | **0 %** | Indicates the system is essentially idle. |
| **Main storage size** | **133 MB** | Total RAM allocated to the system. |
| **System ASP used** | 56 % | How much of the ASP's storage is in use. |

> **Bottom line:** CPU is not a bottleneck right now, and memory usage is comfortably below capacity.

────────────────────────────────────────────────────────────────────────────────

👤 You: Show me memory pool information
🤖 IBM i Performance Monitor: [analyzes memory pools]

👤 You: quit
👋 Goodbye!
```

### Test Security Agent with Category Filter
```bash
# Test only vulnerability assessment tools
uv run src/ibmi_agents/agents/test_agents.py --agent security --category vulnerability-assessment

# Available categories:
# - vulnerability-assessment: Identify security vulnerabilities
# - audit: Audit security configurations
# - remediation: Generate and execute security fixes
# - user-management: Manage user capabilities and permissions
```

### Test with Different Models
```bash
# Use OpenAI GPT-4o
uv run src/ibmi_agents/agents/test_agents.py --agent performance --model openai:gpt-4o

# Use Anthropic Claude
uv run src/ibmi_agents/agents/test_agents.py --agent discovery --model anthropic:claude-3-7-sonnet-20250219

# Use local Ollama model
uv run src/ibmi_agents/agents/test_agents.py --agent search --model ollama:llama3.2
```

### Test All Agents
```bash
# Run comprehensive test suite
uv run src/ibmi_agents/agents/test_agents.py
```

## Agent Details

### 1. Performance Agent

**Purpose**: Monitor and analyze IBM i system performance

**Tools Available**: 12 performance monitoring tools

**Example Questions**:
- "What is my system status?"
- "Show me memory pool utilization"
- "Which jobs are consuming the most CPU?"
- "What is the current system activity level?"

**Sample Output**:
```
### Quick‑look snapshot

| Metric | Value | Why it matters |
|--------|-------|----------------|
| **Configured CPUs** | 3 | The number of logical CPUs the system is allowed to use. |
| **Current CPU capacity** | 3 | How many CPUs are actually available right now. |
| **Average CPU utilization** | **0 %** | Indicates the system is essentially idle. |
| **Main storage size** | **133 MB** | Total RAM allocated to the system. |
| **System ASP used** | 56 % | How much of the ASP's storage is in use. |

> **Bottom line:** CPU is not a bottleneck right now, and memory usage is comfortably below capacity.
```

### 2. Discovery Agent

**Purpose**: High-level system discovery and summarization

**Tools Available**: 5 discovery tools

**Example Questions**:
- "Give me an overview of available system services"
- "How many services are in each schema?"
- "What types of SQL objects are available?"

### 3. Browse Agent

**Purpose**: Detailed system browsing and exploration

**Tools Available**: 4 browse tools

**Example Questions**:
- "Show me services in the QSYS2 schema"
- "List all views related to system monitoring"
- "What procedures are available for job management?"

### 4. Search Agent

**Purpose**: Find specific services and usage information

**Tools Available**: 5 search tools

**Example Questions**:
- "Search for services related to system status"
- "Find examples of using ACTIVE_JOB_INFO"
- "Where is the SYSTEM_STATUS service located?"

### 5. Security Agent

**Purpose**: Security vulnerability assessment and remediation

**Tools Available**: 25 security tools

**Special Feature**: 🔒 **Human-in-the-Loop Approval**

The security agent automatically enables human-in-the-loop approval for non-readonly operations:

- **Read-only tools** (vulnerability assessment, auditing) execute immediately
- **Write operations** (remediation, configuration changes) require manual approval

**How it works**:
1. The agent identifies tools marked with `readOnly: false` in their metadata
2. Before executing these tools, the agent pauses and requests approval
3. You can approve or reject the operation
4. This prevents accidental system changes during security assessments

**Tools requiring approval**:
- `repopulate_special_authority_detail` - Refreshes security audit data
- `execute_impersonation_lockdown` - Applies security remediation commands

**Example Questions**:
- "Check for user profiles vulnerable to impersonation attacks"
- "List database files with public write access"
- "Analyze library list security vulnerabilities"
- "Generate commands to lock down impersonation vulnerabilities"

**Security Categories** (use with `--category` flag):
- `vulnerability-assessment`: Identify security vulnerabilities
- `audit`: Audit security configurations
- `remediation`: Generate and execute security fixes
- `user-management`: Manage user capabilities and permissions

## Advanced Options

### Using Agents in Python Code

```python
import asyncio
from ibmi_agents import create_ibmi_agent, chat_with_agent

async def main():
    # Create a performance agent
    ctx = await create_ibmi_agent("performance", model_id="ollama:llama3.2")
    
    # Use the agent within its context
    async with ctx as (agent, session):
        # Send a query
        response = await chat_with_agent(
            agent,
            "What is my system status? Give me CPU and memory metrics.",
            thread_id="my-session-1"
        )
        print(response)

if __name__ == "__main__":
    asyncio.run(main())
```

### Available Python Functions

```python
from ibmi_agents import (
    create_ibmi_agent,                    # Create any agent by type
    create_performance_agent,             # Create performance agent
    create_sysadmin_discovery_agent,      # Create discovery agent
    create_sysadmin_browse_agent,         # Create browse agent
    create_sysadmin_search_agent,         # Create search agent
    create_security_ops_agent,            # Create security agent
    chat_with_agent,                      # Send message to agent
    list_available_agents,                # Get agent information
    set_verbose_logging,                  # Control logging verbosity
    get_verbose_logging,                  # Check logging status
)
```

### Debug Mode

Enable verbose logging to see detailed tool calls and responses:

```bash
# Via command line
uv run src/ibmi_agents/agents/test_agents.py --agent performance --verbose

# Or in .env
VERBOSE_LOGGING=true
```

### LangSmith Tracing

For advanced debugging, enable LangSmith tracing:

```bash
# In .env
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=your_langsmith_key_here
LANGCHAIN_PROJECT=ibmi-agents
```

Then view traces at: https://smith.langchain.com/

## Architecture Overview

### How It Works

1. **Agent Selection**: You choose an agent specialized for a specific task (performance, discovery, security, etc.)
2. **MCP Connection**: The agent connects to the IBM i MCP Server via HTTP
3. **Tool Filtering**: Each agent only has access to relevant tools (e.g., performance agent gets 12 performance tools)
4. **Model Execution**: Your chosen LLM model processes requests and generates tool calls
5. **Human-in-the-Loop**: Security operations pause for approval before executing write operations
6. **Persistent Memory**: Agent sessions maintain context using in-memory checkpointing


## Troubleshooting

### MCP Server Not Running
```
Error: Connection refused to http://127.0.0.1:3010/mcp
```

**Solution**: Start the IBM i MCP Server
```bash
cd /path/to/ibmi-mcp-server
npm run dev
```

### Ollama Model Not Found
```
Error: model 'llama3.2' not found
```

**Solution**: Pull the model
```bash
ollama pull llama3.2
```

### API Key Not Set
```
Error: OpenAI API key not found
```

**Solution**: Set the API key in `.env`
```bash
OPENAI_API_KEY=sk-...
```

### Import Errors
```
ModuleNotFoundError: No module named 'ibmi_agent_sdk'
```

**Solution**: Install the SDK package
```bash
cd ../../packages/ibmi-agent-sdk
uv pip install -e .
```

## Additional Resources

- **IBM i MCP Server Documentation**: See main project README
- **LangChain Documentation**: https://python.langchain.com/
- **LangGraph Documentation**: https://langchain-ai.github.io/langgraph/
- **Ollama Documentation**: https://ollama.ai/docs