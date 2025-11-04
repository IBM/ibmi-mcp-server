# IBM i MCP Server - Python Client Examples

This directory contains example AI agents that interact with the IBM i MCP Server.

## Quick Setup

### 1. Install uv (recommeded)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```
### 1. Create Virtual Environment and Install Dependencies

```bash
cd client
uv sync
```

### 2. Start the MCP Server

Ensure the IBM i MCP server is running:

```bash
# From the main project directory
cd ibmi-mcp-server
npm run start:http
```

### 3. Run MCP Client Script

In another terminal, navigate to the `client` directory (this directory) and run:

```bash
uv run mcp_client.py
```

### 4. Run the Agent

#### Configure API Key

Create a `.env` file in this directory with your OpenAI API key:

```bash
# Create .env file
cat > .env << EOF
OPENAI_API_KEY=your-openai-api-key-here
EOF
```

**Get your OpenAI API key:**

1. Visit [OpenAI API Keys](https://platform.openai.com/api-keys)
2. Create a new API key
3. Copy it to your `.env` file

```bash
# Use a custom prompt
uv run agent.py -p "What's my system status?" --model-id "openai:gpt-4o"

# Or run with the default prompt
uv run agent.py

# Get help
uv run agent.py -h
```

To run the agent with ollama:
  
```bash
uv run agent.py -p "What's my system status?" --model-id "ollama:qwen2.5:latest"

# with gpt-oss
uv run agent.py -p "What's my system status?" --model-id "ollama:gpt-oss:latest"
```


## Available test agents and scripts

- `agent.py`: The main example agent that connects to your IBM i MCP server and allows natural language queries.
- `list_tool_annotations.py`: A test script that demonstrates how to use tool annotations with the agent.
- `list_toolset_resources.py`: A test script that demonstrates how to use toolset resources with the agent.
- `test_auth_agent.py`: A test script that demonstrates how to use authentication with the agent.
