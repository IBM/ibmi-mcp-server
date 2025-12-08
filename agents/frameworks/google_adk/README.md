# IBM i MCP Agents: Google ADK

AI agents for IBM i system administration and monitoring built with Google's Agent Development Kit (ADK) and Model Context Protocol (MCP) tools. This project provides intelligent agents that can analyze IBM i system performance, manage resources, and assist with administrative tasks.

## What is this project?

The IBM i MCP Agents project provides Python-based intelligent agents that leverage MCP tools to perform system administration tasks on IBM i systems using Google's ADK framework.

### Key Features

- **Multiple Specialized Agents**: Five purpose-built agents for different IBM i tasks
- **Multi-Agent Coordination**: Intelligent routing between specialized sub-agents
- **Multi-Model Support**: Works with Google Gemini, OpenAI, Anthropic, and other providers via LiteLLM
- **MCP Integration**: Connects to the IBM i MCP Server for system operations
- **Interactive Web UI**: Built-in ADK Web interface for testing and debugging
- **Evaluation Framework**: Track and analyze agent performance

### Available Agents

1. **Performance Agent** - Monitor and analyze system performance metrics (CPU, memory, I/O)
2. **Security Agent** - Analyze security configurations, vulnerabilities, and compliance
3. **Discovery Agent** - High-level system discovery, inventory, and service summaries
4. **Browse Agent** - Detailed exploration of system services by category or schema
5. **Search Agent** - Find specific services, programs, or system resources

## Requirements

- **Python 3.13+** - The project requires Python 3.13 or newer
- **uv** - Python package manager for installing dependencies ([Install uv](https://astral.sh/uv/))
- **IBM i MCP Server** - Must be installed and running on your system
- **API Keys** - For your chosen LLM provider (Google AI, OpenAI, Anthropic, or others)

## Setup Guide

Follow these step-by-step instructions to set up and run the IBM i Google ADK MCP Agents.

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
npx ibmi-mcp-server --transport http --tools ./tools
```

The server will start on `http://127.0.0.1:3010/mcp` by default.

### Step 3: Configure Environment Variables

Create a `.env` file in the `agents/frameworks/google_adk` directory:

```bash
cd agents/frameworks/google_adk
touch .env
```

**3.1 Choose your model provider:**

**Option A: Google AI (Simplest - Recommended)**

1. Get an API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Add to your `.env` file:

```bash
# Google AI Configuration
GOOGLE_API_KEY=your_google_api_key_here
IBMI_AGENT_MODEL=gemini-2.0-flash-exp

# IBM i MCP Server
IBMI_MCP_ACCESS_TOKEN=your_mcp_token
IBMI_MCP_SERVER_URL=http://127.0.0.1:3010/mcp
```

**Option B: Vertex AI (Enterprise)**

1. Create a [Google Cloud Project](https://console.cloud.google.com/)
2. Enable [Vertex AI API](https://console.cloud.google.com/apis/library/aiplatform.googleapis.com)
3. Create service account credentials
4. Add to your `.env` file:

```bash
# Vertex AI Configuration
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=secrets/credentials.json
VERTEX_AI_LOCATION=us-central1
GOOGLE_GENAI_USE_VERTEXAI=TRUE
IBMI_AGENT_MODEL=gemini-2.0-flash-exp

# IBM i MCP Server
IBMI_MCP_ACCESS_TOKEN=your_mcp_token
IBMI_MCP_SERVER_URL=http://127.0.0.1:3010/mcp
```

**Option C: OpenAI via LiteLLM**

```bash
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key
IBMI_AGENT_MODEL=gpt-4o

# IBM i MCP Server
IBMI_MCP_ACCESS_TOKEN=your_mcp_token
IBMI_MCP_SERVER_URL=http://127.0.0.1:3010/mcp
```

**Option D: Anthropic via LiteLLM**

```bash
# Anthropic Configuration
ANTHROPIC_API_KEY=your_anthropic_api_key
IBMI_AGENT_MODEL=claude-3-5-sonnet-20241022

# IBM i MCP Server
IBMI_MCP_ACCESS_TOKEN=your_mcp_token
IBMI_MCP_SERVER_URL=http://127.0.0.1:3010/mcp
```

### Step 4: Install Dependencies

```bash
cd agents/frameworks/google_adk
uv venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
uv sync
```

### Step 5: Run an Agent

**5.1 Using the ADK Web UI (Recommended):**

```bash
cd agents/frameworks/google_adk
adk web
```

This will:
- Start a local web server
- Open your browser to the ADK Web UI
- Load the multi-agent system from `adk_agents/`

**5.2 Using the command line:**

```bash
# Run a specific agent with a query
uv run src/ibmi_agents/agents/ibmi_agents.py --agent performance --query "Show me system CPU usage"

# List available agents
uv run src/ibmi_agents/agents/ibmi_agents.py --list-agents
```

**5.3 Interact with the agent CLI:**

```bash
cd agents/frameworks/google_adk
adk run adk_agents
```
- Type your questions or requests at the prompt
- The agent will use IBM i MCP tools to fulfill your requests
- Type `exit` to end the session

## Usage Examples

### Performance Monitoring
```bash
uv run src/ibmi_agents/agents/ibmi_agents.py --agent performance --query "What is the current CPU utilization?"
```
Example questions:
- "Show me system CPU usage"
- "What are the top 10 CPU consumers?"
- "Analyze memory pool utilization"

### Security Analysis
```bash
uv run src/ibmi_agents/agents/ibmi_agents.py --agent security --query "Check system security configuration"
```
Example questions:
- "Analyze system security vulnerabilities"
- "Check user access controls"
- "Review security compliance"

### System Discovery
```bash
uv run src/ibmi_agents/agents/ibmi_agents.py --agent discovery --query "List all available schemas"
```
Example questions:
- "Give me an overview of the system services"
- "What databases are available?"
- "Show me system categories"

### Detailed Browsing
```bash
uv run src/ibmi_agents/agents/ibmi_agents.py --agent browse --query "Navigate to QSYS2 library"
```
Example questions:
- "Show me details about the QSYS library"
- "Explore the database schemas"
- "What's in the QTEMP library?"

### System Search
```bash
uv run src/ibmi_agents/agents/ibmi_agents.py --agent search --query "Find services related to performance"
```
Example questions:
- "Find all programs named CUST*"
- "Search for SQL examples with 'CPU'"
- "Locate file CUSTOMER in any library"

## Advanced Options

### Debug Mode
Enable verbose output to troubleshoot issues:
```bash
uv run src/ibmi_agents/agents/ibmi_agents.py --agent performance --query "Show me CPU usage" --verbose
```

### Quiet Mode
Only show final response without logs:
```bash
uv run src/ibmi_agents/agents/ibmi_agents.py --agent performance --query "Show me CPU usage" --quiet
```

### Custom Model
Use a different model:
```bash
# Use Gemini 2.5 Flash
uv run src/ibmi_agents/agents/ibmi_agents.py --agent performance --query "Show me CPU usage" --model "gemini-2.5-flash"

# Use OpenAI GPT-4o
uv run src/ibmi_agents/agents/ibmi_agents.py --agent performance --query "Show me CPU usage" --model "gpt-4o"

# Use Anthropic Claude
uv run src/ibmi_agents/agents/ibmi_agents.py --agent performance --query "Show me CPU usage" --model "claude-3-5-sonnet-20241022"
```

## Architecture Overview

### How It Works

1. **Agent Selection**: You choose an agent specialized for a specific task (performance, discovery, etc.)
2. **MCP Connection**: The agent connects to the IBM i MCP Server via HTTP
3. **Tool Filtering**: Each agent only has access to relevant tools (e.g., performance agent gets performance tools)
4. **Model Execution**: Gemini model processes requests and generates tool calls
5. **Multi-Agent Coordination**: The coordinator routes complex queries to appropriate sub-agents

### Supported Models

#### Google Gemini Models

| Model | Description | Best For |
|-------|-------------|----------|
| `gemini-3-pro-preview` | Preview of next generation | Advanced capabilities |
| `gemini-2.5-pro` | State-of-the-art thinking model | Advanced capabilities |
| `gemini-2.5-flash` | Stable flash model | Production workloads |
| `gemini-2.0-flash-exp` | Latest experimental flash model | Fast responses, general tasks |
| `gemini-2.0-pro-exp` | Experimental pro model | Complex reasoning |

#### OpenAI Models and Anthropic Models (via LiteLLM or Vertex AI)

| Model | Description |
|-------|-------------|
| `gpt-4o` | Latest GPT-4 Optimized |
| `claude-3-5-sonnet-20241022` | Latest Claude 3.5 Sonnet |

#### Vertex AI Model Garden

Access additional models through Vertex AI Model Garden:
- Meta Llama models
- Mistral models
- And more

For complete model information, see [Google ADK Models Documentation](https://google.github.io/adk-docs/agents/models/).

## Multi-Agent System

The `adk_agents/` directory contains a sophisticated multi-agent system with a coordinator that intelligently routes queries to specialized sub-agents. See [Multi-Agent System Documentation](./adk_agents/README.md) for details.

## Troubleshooting

### IBM i MCP Server Issues

**Connection errors:**
- Verify the MCP server is running: `curl http://127.0.0.1:3010/mcp`
- Check `IBMI_MCP_ACCESS_TOKEN` is set correctly
- Ensure the server URL matches your configuration

### Google AI / Vertex AI Issues

**API key not valid:**
- Verify your `GOOGLE_API_KEY` is correct
- Check the API key is enabled in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
- Ensure you've enabled the Gemini API

**Permission denied (403):**
- Verify service account has "Vertex AI User" role
- Check billing is enabled for your project
- Ensure Vertex AI API is enabled

**Model not found:**
- Verify model name in `IBMI_AGENT_MODEL`
- Check [Google AI Studio](https://aistudio.google.com/) for available models
- For OpenAI/Anthropic: Ensure correct API key is set
- Try using `gemini-2.0-flash-exp` as a default

**Rate limit exceeded (429):**
- You've hit API rate limits
- **For Google AI**: Check [quota limits](https://aistudio.google.com/app/apikey)
- **For Vertex AI**: Review [quota settings](https://console.cloud.google.com/iam-admin/quotas)
- **For OpenAI**: Check [usage limits](https://platform.openai.com/account/limits)
- **For Anthropic**: Review [rate limits](https://docs.anthropic.com/claude/reference/rate-limits)
- **Solutions**:
  - Wait and retry (rate limits reset over time)
  - Upgrade your plan for higher limits
  - Request quota increases from your provider
  - Switch to a different model or provider
  - Implement exponential backoff in your code

**Environment variable not set:**
- Ensure `.env` file is in `agents/frameworks/google_adk/`
- Verify variable names are spelled correctly (case-sensitive)
- Use `--verbose` flag to check if `.env` is being loaded

**LiteLLM configuration:**
- Set `LITELLM_API_KEY` for OpenAI or Anthropic
- Model names must match provider format:
  - OpenAI: `gpt-4o`, `gpt-4o-mini`
  - Anthropic: `claude-3-5-sonnet-20241022`
- For custom endpoints, see [LiteLLM docs](https://docs.litellm.ai/)

### ADK Web UI Issues

**Web UI doesn't load:**
- Clear browser cache and reload
- Check browser console for errors (F12 → Console)
- Ensure `adk web` command is running
- Verify network connectivity

**Agent not responding:**
- Check IBM i MCP server is running
- Verify `IBMI_MCP_ACCESS_TOKEN` is set
- Review execution traces in the UI
- Check `.adk/eval_history/` for detailed logs

### Debug Tips

1. **Enable verbose logging:**
   ```bash
   uv run src/ibmi_agents/agents/ibmi_agents.py --agent performance --query "test" --verbose
   ```

2. **Test Google Cloud setup:**
   ```bash
   gcloud auth application-default print-access-token
   gcloud config get-value project
   ```

3. **Verify credentials file:**
   ```bash
   cat secrets/credentials.json | python -m json.tool
   ```

For more troubleshooting information, see [Google ADK Troubleshooting](https://google.github.io/adk-docs/agents/models/#troubleshooting).

## Resources

- [Google ADK Documentation](https://google.github.io/adk-docs)
- [Google ADK Models Guide](https://google.github.io/adk-docs/agents/models/)
- [ADK Web Interface Guide](https://github.com/google/adk-web)
- [ADK Evaluation Framework](https://google.github.io/adk-docs/evaluate/)
- [IBM i MCP Server Documentation](../../../README.md)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
- [Multi-Agent System Implementation](./adk_agents/README.md)

## License

This project is licensed under the MIT License - see the LICENSE file for details.