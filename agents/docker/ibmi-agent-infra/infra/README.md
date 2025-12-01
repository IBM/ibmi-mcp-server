# Configuration Guide

Centralized, type-safe configuration for the IBM i Agent Infrastructure. The system uses two configuration files:

1. **`.env`** - API keys, database credentials, MCP connection (sensitive data)
2. **`config.yaml`** - Agent behavior, model selection, UI settings (version controlled)

---

## Configuration Files

### 1. Environment Variables (`.env`)

Create `infra/.env` with your API keys and connection settings:

```bash
cp infra/.env.example infra/.env
```

```bash
# ============================================================
# MCP Server (Required) - IBM i database access
# ============================================================
# The MCP server runs automatically in Docker Compose
# Use ibmi-mcp-server:3010 for container-to-container communication
MCP_URL=http://ibmi-mcp-server:3010/mcp
MCP_TRANSPORT=streamable-http

# ============================================================
# AI Model Provider (Choose at least one)
# ============================================================

# Option 1: watsonx (IBM Cloud)
# Get keys from: https://cloud.ibm.com
WATSONX_API_KEY=your_ibm_cloud_api_key
WATSONX_PROJECT_ID=your_project_id
WATSONX_URL=https://us-south.ml.cloud.ibm.com
WATSONX_MODEL_ID=meta-llama/llama-3-3-70b-instruct

# Option 2: OpenAI
# Get key from: https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-your_openai_key

# Option 3: Anthropic
# Get key from: https://console.anthropic.com
ANTHROPIC_API_KEY=sk-your_anthropic_key
```
> **Note**: The default model is `"anthropic:claude-haiku-4-5"`

#### Getting API Keys

**watsonx (IBM Cloud):**
1. Sign up at [cloud.ibm.com](https://cloud.ibm.com)
2. Navigate to IBM watsonx.ai
3. Create a project and note the Project ID
4. Generate an API key from IAM (Identity & Access Management)

**OpenAI:**
1. Sign up at [platform.openai.com](https://platform.openai.com)
2. Navigate to API Keys
3. Click "Create new secret key"
4. Copy the key immediately (shown only once)

**Anthropic:**
1. Sign up at [console.anthropic.com](https://console.anthropic.com)
2. Navigate to API Keys
3. Create a new API key
4. Copy the key immediately (shown only once)

#### MCP Server Configuration

The MCP server runs automatically as part of the Docker Compose stack:
- **Container name**: `ibmi-mcp-server`
- **Port**: `3010`
- **Health endpoint**: `http://localhost:3010/health`
- **MCP endpoint**: `http://ibmi-mcp-server:3010/mcp` (inside Docker network)

**Network Configuration:**
- **Inside Docker network**: Use `http://ibmi-mcp-server:3010/mcp` (recommended)
- **From host machine**: Use `http://localhost:3010/mcp`
- **From external**: Use `http://host.docker.internal:3010/mcp`

The MCP server configuration is loaded from the monorepo root `.env` file (not `infra/.env`).

---

### 2. Agent Configuration (`config.yaml`)

The `config.yaml` file controls agent behavior, model selection, and UI settings. 

#### Agent Configuration

**performance monitoring agent example:**
```yaml
agents:
  # Default model for all agents (can be overridden per agent)
  default_model: "anthropic:claude-haiku-4-5"

  # Performance monitoring agent
  ibmi-performance-monitor:
    # Uses default_model when not specified
    # model:
    enable_reasoning: false
    debug_mode: false
```


Override the default model per agent as needed. Supported models include:
- **watsonx**: `meta-llama/llama-3-3-70b-instruct`, etc.
- **OpenAI**: `gpt-4o`, etc.
- **Anthropic**: `claude-sonnet-4-5-20250929`, etc.

