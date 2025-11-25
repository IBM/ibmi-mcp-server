# Configuration System

Centralized, type-safe configuration for the IBM i Agent Infrastructure. All configuration is loaded from environment variables via `.env` file.

## Quick Start

1. Copy the template below to `infra/.env`
2. Add your API keys (watsonx and/or OpenAI)
3. Configure MCP server URL and database connection

## Environment Variables

Create `infra/.env` with the following:

```bash
# MCP Server (IBM i database access)
MCP_URL=http://127.0.0.1:3010/mcp
MCP_TRANSPORT=streamable-http

# watsonx (get keys from cloud.ibm.com)
WATSONX_API_KEY=your_ibm_cloud_api_key
WATSONX_PROJECT_ID=your_project_id
WATSONX_URL=https://us-south.ml.cloud.ibm.com
WATSONX_MODEL_ID=meta-llama/llama-3-3-70b-instruct

# OpenAI (get key from platform.openai.com)
OPENAI_API_KEY=sk-your_openai_key

# Application
DEBUG=false
LOG_LEVEL=INFO
```

**MCP Server:**
- Must be running locally or accessible via HTTP
- Default: `http://127.0.0.1:3010/mcp`
- See main [ibmi-mcp-server README](../../../README.md) for setup

## Usage in Code

```python
from infra.config import config

# MCP configuration
print(config.mcp.url)
print(config.mcp.transport)

# watsonx configuration
if config.watsonx.is_configured:
    model_kwargs = config.watsonx.to_model_kwargs()

# OpenAI configuration
if config.openai.is_configured:
    model_kwargs = config.openai.to_model_kwargs()
```
