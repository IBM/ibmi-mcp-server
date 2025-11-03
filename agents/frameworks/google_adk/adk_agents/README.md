# IBM i ADK Multi-Agent System

A Google ADK-based multi-agent system for IBM i system administration and performance monitoring. This implementation uses a coordinator pattern with specialized sub-agents for different IBM i operational domains.

## Architecture

### Coordinator Agent (`agent.py`)
The root agent acts as an intelligent router that delegates user queries to specialized sub-agents:

- **Model**: Gemini 2.5 Flash
- **Planner**: PlanReActPlanner for multi-step reasoning
- **Plugins**: ReflectAndRetryToolPlugin (max 3 retries)

### Sub-Agents

1. **Performance Agent** (`performance_agent.py`)
   - Analyzes CPU, memory, I/O, and subsystem performance
   - Tools: `system_status`, `system_activity`, `active_job_info`, `memory_pools`, `temp_storage_buckets`, `unnamed_temp_storage`, `http_server`, `collection_services`, `collection_categories`, `system_values`

2. **SysAdmin Discover Agent**
   - Lists and summarizes schemas, categories, and system organization

3. **SysAdmin Browse Agent**
   - Navigates and explores libraries, schemas, and object hierarchies

4. **SysAdmin Search Agent**
   - Finds objects, services, or SQL examples by name or keyword

## Prerequisites

- Python 3.10+
- Google ADK installed
- IBM i MCP Server running (default: `http://127.0.0.1:3010/mcp`)
- Valid IBM i MCP access token

## Setup and Running

### Prerequisites

1. **Install Google ADK**
   ```bash
   pip install google-adk[eval]
   ```

2. **Start IBM i MCP Server**
   
   Ensure your IBM i MCP server is running and accessible:
   ```bash
   # From the repository root
   npx ibmi-mcp-server --transport http --tools ./tools 
   ```
   
   Default URL: `http://127.0.0.1:3010/mcp`

3. **Configure Environment Variables**

   Get the google api key by following quick start guide in [README.md](../README.md).

   Create a `.env` file in the `adk_agents` directory:
   ```bash
   GOOGLE_GENAI_USE_VERTEXAI=0
   GOOGLE_API_KEY=your_google_api_key
   IBMI_MCP_ACCESS_TOKEN=your_bearer_token_here
   ```

### Running with ADK Web UI

The ADK Web UI provides an interactive interface for testing and debugging your agents locally.

#### Step 1: Start ADK Web Server

From the parent folder of the `adk_agents` directory:

```bash
google_adk/      <-- navigate to this directory
    adk_agents/
        __init__.py
        agent.py
        .env
        README.md
``` 

```bash
cd agents/frameworks/google_adk
adk web
```

This command will:
- Start a local web server
- Automatically open your browser to the ADK Web UI
- Load your agent configuration from `agent.py`

#### Step 2: Interact with Your Agent

In the ADK Web UI:

1. **Chat Interface**: Type queries in the chat box to interact with your agents
   ```
   Show me system CPU usage
   ```

2. **View Agent Execution**: The UI displays:
   - Which sub-agent is handling the request
   - Tool calls being made to the MCP server
   - Responses and results
   - Execution traces and logs

3. **Test Different Queries**: Try various queries to test agent routing:
   ```
   What are the top 10 CPU consumers?
   List all available schemas
   Find services related to performance
   ```

#### Step 3: Debug and Iterate

The Web UI provides debugging features:

- **Execution Traces**: See step-by-step agent reasoning
- **Tool Call Inspection**: View MCP tool parameters and responses
- **Error Messages**: Detailed error information when issues occur
- **Conversation History**: Review previous interactions


Or use the ADK CLI:

```bash
# Navigate to the adk_agents parent directory
cd agents/frameworks/google_adk

# Run with ADK CLI
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

The coordinator agent uses the following routing logic:

1. **Understand Intent**: Parse user query to determine domain
2. **Route to Correct Agent**: 
   - Performance → CPU, jobs, memory, I/O, tuning
   - Discovery → Listing schemas, categories, organization
   - Browse → Navigating libraries, schemas, hierarchies
   - Search → Finding objects, services, SQL examples
3. **Combine Agents**: Chain agents for multi-step goals (Discovery → Browse → Search)
4. **Context Management**: Preserve outputs when delegating between agents
5. **Response Format**: Explain routing, summarize results, suggest next steps

## MCP Tool Integration

The agents connect to the IBM i MCP Server via HTTP with bearer token authentication:

```python
McpToolset(
    connection_params=StreamableHTTPConnectionParams(
        url="http://127.0.0.1:3010/mcp",
        headers={"Authorization": f"Bearer {os.getenv('IBMI_MCP_ACCESS_TOKEN')}"}
    ),
    tool_filter=['system_status', 'system_activity', ...]
)
```

### Tool Filtering

Each sub-agent has a curated set of tools relevant to its domain. The `tool_filter` parameter ensures agents only access appropriate MCP tools.

## Configuration

### Customizing the MCP URL

Set the `DEFAULT_MCP_URL` environment variable or modify the default in `performance_agent.py`:

```python
DEFAULT_MCP_URL = "http://your-mcp-server:3010/mcp"
```

### Adjusting Retry Behavior

Modify the `ReflectAndRetryToolPlugin` configuration in `agent.py`:

```python
plugins=[
    ReflectAndRetryToolPlugin(max_retries=5),  # Increase retries
]
```

### Changing the Model

Update the `model` parameter in agent definitions:

```python
root_agent = Agent(
    model='gemini-2.0-flash-exp',  # Use different model
    ...
)
```

## Evaluation History

ADK automatically tracks evaluation runs in `.adk/eval_history/`. Review these files to analyze agent performance and improve prompts. You can know more about it in [ADK Evals](https://google.github.io/adk-docs/evaluate/#example-test-code).

## Troubleshooting

### Authentication Errors
- Verify `IBMI_MCP_ACCESS_TOKEN` is set correctly
- Ensure the token hasn't expired
- Check MCP server is running and accessible

### Connection Issues
- Confirm MCP server URL is correct
- Test connectivity: `curl http://127.0.0.1:3010/mcp`
- Check firewall rules if using remote MCP server

### Tool Execution Failures
- Review `.adk/eval_history/` for detailed error logs
- Verify tool names match available MCP tools
- Check MCP server logs for backend issues

### Web UI Issues
- Clear browser cache if UI doesn't load
- Check browser console for JavaScript errors
- Ensure ADK web server is running (`adk web`)
- Verify network connectivity to deployment

## Development

### Adding New Sub-Agents

1. Create a new file in `sub_agents/`
2. Define the agent with appropriate tools and instructions
3. Import and add to `root_agent.sub_agents` list in `agent.py`
4. Update the coordinator's delegation strategy
5. Run 'adk web' comamand

### Testing Locally

```bash
# Run with ADK CLI
adk run adk_agents
```

## Resources

- [Google ADK Documentation](https://google.github.io/adk-docs)
- [ADK Web Interface Guide](https://github.com/google/adk-web)
- [IBM i MCP Server Documentation](../../../../server/README.md)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)

## License

See repository root for license information.