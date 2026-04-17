# IBM i MCP Agent Examples

⚠️ **These example scripts are deprecated and will be moved to the `client/` directory in a future release. Please refer to the [client/README.md](../../../client/README.md) for the latest instructions.** ⚠️

This directory contains example AI agents that interact with the IBM i MCP Server.

## Quick Setup

### 1. Install uv (recommeded)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

or create a virtual environment manually:

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure API Key

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

### 3. Start the MCP Server

Ensure the IBM i MCP server is running:

```bash
# From the main project directory
cd ibmi-mcp-server
npm run start:http
```

### 4. Run MCP Client Script

In another terminal, navigate to the `server/tests/agents` directory and run:

```bash
uv run mcp_client.py
```

### 5. Run the Agent

```bash
# Use a custom prompt
uv run agent.py -p "What's my system status?"

# Or run with the default prompt
uv run agent.py

# Get help
uv run agent.py -h
```

**Note:** You can also activate the virtual environment with `source .venv/bin/activate` and run python files with `python`.

## Available test agents and scripts

- `agent.py`: The main example agent that connects to your IBM i MCP server and allows natural language queries.
- `list_tool_annotations.py`: A test script that demonstrates how to use tool annotations with the agent.
- `list_toolset_resources.py`: A test script that demonstrates how to use toolset resources with the agent.

## MCP Context Forge (Coming Soon)
