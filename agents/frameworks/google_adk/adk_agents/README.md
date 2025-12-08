# IBM i ADK Multi-Agent System

A Google ADK-based multi-agent system for IBM i system administration and performance monitoring. This implementation uses a coordinator pattern with specialized sub-agents for different IBM i operational domains.

## What is this?

The multi-agent system provides intelligent routing between specialized agents, allowing complex queries to be handled by the most appropriate agent. The coordinator analyzes user intent and delegates to sub-agents with relevant expertise.

## Architecture

### Coordinator Agent

The root agent acts as an intelligent router that delegates user queries to specialized sub-agents:

- **Model**: Gemini 2.0 Flash
- **Planner**: PlanReActPlanner for multi-step reasoning
- **Plugins**: ReflectAndRetryToolPlugin (max 3 retries)

### Sub-Agents

1. **Performance Agent** - Analyzes CPU, memory, I/O, and subsystem performance
2. **Security Agent** - Analyzes security configurations, vulnerabilities, and compliance
3. **SysAdmin Discovery Agent** - Lists and summarizes schemas, categories, and system organization
4. **SysAdmin Browse Agent** - Navigates and explores libraries, schemas, and object hierarchies
5. **SysAdmin Search Agent** - Finds objects, services, or SQL examples by name or keyword

## Requirements

- Python 3.13+
- Google ADK installed
- IBM i MCP Server running (default: `http://127.0.0.1:3010/mcp`)
- Valid IBM i MCP access token
- Google API key (from [Google AI Studio](https://aistudio.google.com/app/apikey))

## Setup Guide

### Step 1: Install Google ADK

```bash
pip install google-adk[eval]
```

### Step 2: Start IBM i MCP Server

Ensure your IBM i MCP server is running:

```bash
# From the repository root
npx ibmi-mcp-server --transport http --tools ./tools 
```

Default URL: `http://127.0.0.1:3010/mcp`

### Step 3: Configure Environment Variables

Create a `.env` file in the `adk_agents` directory:

```bash
# Google AI Configuration
GOOGLE_API_KEY=your_google_api_key
IBMI_AGENT_MODEL=gemini-2.0-flash

# IBM i MCP Server
IBMI_MCP_ACCESS_TOKEN=your_bearer_token_here
IBMI_MCP_SERVER_URL=http://127.0.0.1:3010/mcp
```

> [!TIP]
> Get your Google API key from [Google AI Studio](https://aistudio.google.com/app/apikey). See the [parent README](../README.md) for detailed setup instructions.

## Running the Multi-Agent System

### Using ADK Web UI (Recommended)

The ADK Web UI provides an interactive interface for testing and debugging.

**Navigate to the parent directory:**

```bash
cd agents/frameworks/google_adk
adk web
```

This will:
- Start a local web server
- Open your browser to the ADK Web UI
- Load the multi-agent configuration from `adk_agents/`

**Interact with the agents:**

Type queries in the chat interface:
```
Show me system CPU usage
What are the top 10 CPU consumers?
List all available schemas
Find services related to performance
```

The UI displays:
- Which sub-agent is handling the request
- Tool calls being made to the MCP server
- Responses and results
- Execution traces and logs

### Using ADK CLI

```bash
cd agents/frameworks/google_adk
adk run adk_agents
```

## Usage Examples

### Performance Queries
```
"Show me system CPU usage"
"What are the top 10 CPU consumers?"
"Analyze memory pool utilization"
"Check HTTP server performance"
```

### Security Queries
```
"Check system security configuration"
"Analyze user access controls"
"Review security vulnerabilities"
"Check compliance status"
```

### Discovery Queries
```
"List all available schemas"
"Show me system categories"
"What services are available?"
```

### Browse Queries
```
"Navigate to QSYS2 library"
"Show objects in MYLIB"
"Explore database schemas"
```

### Search Queries
```
"Find services related to performance"
"Search for SQL examples with 'CPU'"
"Locate objects named 'CUSTOMER'"
```

## Agent Delegation Strategy

The coordinator uses intelligent routing:

1. **Understand Intent** - Parse user query to determine domain
2. **Route to Correct Agent**:
   - Performance → CPU, jobs, memory, I/O, tuning
   - Security → Security configs, vulnerabilities, compliance
   - Discovery → Listing schemas, categories, organization
   - Browse → Navigating libraries, schemas, hierarchies
   - Search → Finding objects, services, SQL examples
3. **Combine Agents** - Chain agents for multi-step goals
4. **Context Management** - Preserve outputs when delegating
5. **Response Format** - Explain routing, summarize results, suggest next steps

## Configuration

### Customizing the MCP URL

Set in your `.env` file:

```bash
IBMI_MCP_SERVER_URL=http://your-mcp-server:3010/mcp
```

### Adjusting Retry Behavior

Modify in `agent.py`:

```python
plugins=[
    ReflectAndRetryToolPlugin(max_retries=5),  # Increase retries
]
```

### Changing the Model

Update in `agent.py`:

```python
root_agent = Agent(
    model='gemini-2.0-pro-exp',  # Use different model
    ...
)
```

For available models, see [Google ADK Models Documentation](https://google.github.io/adk-docs/agents/models/).

## Troubleshooting

### Authentication Errors
- Verify `IBMI_MCP_ACCESS_TOKEN` is set correctly
- Ensure the token hasn't expired
- Check MCP server is running: `curl http://127.0.0.1:3010/mcp`

### Connection Issues
- Confirm MCP server URL is correct
- Test connectivity: `curl http://127.0.0.1:3010/mcp`
- Check firewall rules if using remote MCP server

### Web UI Issues
- Clear browser cache if UI doesn't load
- Check browser console for JavaScript errors (F12 → Console)
- Ensure `adk web` command is running
- Verify network connectivity

### Google API Issues
- Verify `GOOGLE_API_KEY` is correct
- Check API key is enabled in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
- Ensure Gemini API is enabled for your project

For more troubleshooting, see [Google ADK Troubleshooting](https://google.github.io/adk-docs/agents/models/#troubleshooting).

## Development

### Adding New Sub-Agents

1. Create a new file in `sub_agents/`
2. Define the agent with appropriate tools and instructions
3. Import and add to `root_agent.sub_agents` list in `agent.py`
4. Update the coordinator's delegation strategy
5. Test with `adk web` command

### Testing Locally

```bash
# Run with ADK CLI
adk run adk_agents

# Or use the Web UI
adk web
```

### Evaluation History

ADK tracks evaluation runs in `.adk/eval_history/`. Review these files to analyze agent performance and improve prompts.

Learn more: [ADK Evaluation Framework](https://google.github.io/adk-docs/evaluate/)

## Resources

- [Google ADK Documentation](https://google.github.io/adk-docs)
- [Google ADK Models Guide](https://google.github.io/adk-docs/agents/models/)
- [ADK Web Interface Guide](https://github.com/google/adk-web)
- [ADK Evaluation Framework](https://google.github.io/adk-docs/evaluate/)
- [IBM i MCP Server Documentation](../../../../README.md)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)

## License

See repository root for license information.