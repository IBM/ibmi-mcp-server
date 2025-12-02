# IBM i MCP Agents: Agno

AI agents for IBM i system administration and monitoring built with Agno's AgentOS framework and Model Context Protocol (MCP) tools. This project provides intelligent agents that can analyze IBM i system performance, manage resources, and assist with administrative tasks.

## What is this project?

The IBM i MCP Agents project provides Python-based intelligent agents that leverage MCP tools to perform system administration tasks on IBM i systems.

### Key Features

- **Multiple Specialized Agents**: Six purpose-built agents for different IBM i tasks
- **Multi-Model Support**: Works with OpenAI, Anthropic Claude, IBM WatsonX, and local Ollama models
- **MCP Integration**: Connects to the IBM i MCP Server for system operations
- **Persistent Memory**: Agents maintain context across sessions using SQLite
- **Interactive CLI**: Simple command-line interface for agent interaction

### Available Agents

1. **Performance Agent** - Monitor and analyze system performance metrics (CPU, memory, I/O)
2. **Discovery Agent** - High-level system discovery, inventory, and service summaries
3. **Browse Agent** - Detailed exploration of system services by category or schema
4. **Search Agent** - Find specific services, programs, or system resources
5. **Web Agent** - General web search using DuckDuckGo (no MCP required)
6. **Agno Assist** - Learn about the Agno framework and agent development

## Requirements

- **Python 3.13+** - The project requires Python 3.13 or newer
- **uv** - Python package manager for installing dependencies and managing virtual environments ([Install uv](https://astral.sh/uv/))
- **IBM i MCP Server** - Must be installed and running on your system
- **API Keys** - For your chosen LLM provider (OpenAI, Anthropic, WatsonX, or Ollama)

## Setup Guide

Follow these step-by-step instructions to set up and run the IBM i Agno MCP Agents.

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

**2.1 Follow the MCP Server installation guide →** [Quickstart Guide](../../../README.md#-quickstart)

**2.2 Configure the server →** [Server Configuration Guide](../../../README.md#-configuration)

**2.3 Install dependencies and build the server:**
```bash
cd ibmi-mcp-server
npm install
npm run build
```

**2.4 Start the MCP server:**
```bash
npx ibmi-mcp-server --transport http --tools ./tools
```

The server will start on `http://127.0.0.1:3010/mcp` by default.

### Step 3: Configure Environment Variables

Create a `.env` file in the `agents/frameworks/agno` directory with your API keys:

```bash
cd agents/frameworks/agno
touch .env
```

**3.1 Add API keys for your chosen provider(s):**

```bash
# OpenAI (for GPT-4, GPT-4o models)
OPENAI_API_KEY=sk-your-openai-api-key

# Anthropic (for Claude models)
ANTHROPIC_API_KEY=sk-ant-your-anthropic-api-key

# Ollama (local models - no API key needed)
# Ensure Ollama is installed and running: https://ollama.ai
# Start with: ollama serve
```

**Note:** You only need API keys for the providers you plan to use.

### Step 4: Run an Agent

**4.1 List available agents:**
```bash
cd agents/frameworks/agno
uv run ibmi_agentos.py --list
```

**4.2 Run an agent with your chosen model:**

```bash
# OpenAI GPT-4o
uv run ibmi_agentos.py --agent performance --model openai:gpt-4o

# Anthropic Claude Sonnet
uv run ibmi_agentos.py --agent discovery --model anthropic:claude-sonnet-4-5

# Local Ollama model
uv run ibmi_agentos.py --agent search --model ollama:gpt-oss:20b
```

**4.3 Interact with the agent:**
- Type your questions or requests at the prompt
- The agent will use IBM i MCP tools to fulfill your requests
- Type `exit` or `quit` to end the session

## Usage Examples

### Performance Monitoring
```bash
uv run ibmi_agentos.py --agent performance --model openai:gpt-4o
```
Example questions:
- "What is the current CPU utilization?"
- "Show me memory usage trends"
- "Are there any performance bottlenecks?"

### System Discovery
```bash
uv run ibmi_agentos.py --agent discovery --model openai:gpt-4o
```
Example questions:
- "Give me an overview of the system services"
- "What databases are available?"
- "List all active subsystems"

### Detailed Browsing
```bash
uv run ibmi_agentos.py --agent browse --model openai:gpt-4o
```
Example questions:
- "Show me details about the QSYS library"
- "Explore the database schemas"
- "What's in the QTEMP library?"

### System Search
```bash
uv run ibmi_agentos.py --agent search --model openai:gpt-4o
```
Example questions:
- "Find all programs named CUST*"
- "Search for services containing 'SQL'"
- "Locate file CUSTOMER in any library"

## Advanced Options

### Debug Mode
Enable debug output to troubleshoot issues:
```bash
uv run ibmi_agentos.py --agent performance --model openai:gpt-4o --debug
```

### Custom MCP Server URL
If your MCP server runs on a different host or port:
```bash
uv run ibmi_agentos.py --agent performance --model openai:gpt-4o --mcp-url http://localhost:8080/mcp
```

## Architecture Overview

### How It Works

1. **Agent Selection**: You choose an agent specialized for a specific task (performance, discovery, etc.)
2. **MCP Connection**: The agent connects to the IBM i MCP Server via HTTP
3. **Tool Filtering**: Each agent only has access to relevant tools (e.g., performance agent gets performance tools)
4. **Model Execution**: Your chosen LLM model processes requests and generates tool calls
5. **Persistent Memory**: Agent sessions and memory are stored in SQLite (`tmp/ibmi_agents.db`)

### Supported Models

| Provider | Model Examples | Usage |
|----------|---------------|-------|
| **OpenAI** | gpt-4o, gpt-4o-mini, gpt-4-turbo | `openai:gpt-4o` |
| **Anthropic** | claude-sonnet-4-5, claude-opus-4 | `anthropic:claude-sonnet-4-5` |
| **WatsonX** | llama-3-3-70b, granite-3-3-8b | `watsonx:llama-3-3-70b-instruct` |
| **Ollama** | llama3.2, gpt-oss, mistral | `ollama:llama3.2` |





