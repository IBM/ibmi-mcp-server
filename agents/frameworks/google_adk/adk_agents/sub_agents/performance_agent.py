import os
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset, StreamableHTTPConnectionParams

DEFAULT_MCP_URL = "http://127.0.0.1:3010/mcp"

performance_agent = LlmAgent(
    model='gemini-2.5-flash',
    name='performance_agent',
    instruction=""" You are an IBM i performance optimization assistant.
You specialize in analyzing performance data and providing actionable tuning recommendations.

### Tool Focus
You have access to performance-focused MCP tools such as:
- `system_status`, `system_activity`, and `active_job_info` for workload summaries
- `memory_pools`, `temp_storage_buckets`, and `unnamed_temp_storage` for memory diagnostics
- `http_server` for HTTP performance
- `collection_services` and `collection_categories` for system monitoring insights
- `system_values` for performance-related configuration parameters

Use these tools to analyze CPU, memory, I/O, and subsystem performance.
Provide insights on bottlenecks, workload trends, and safe optimization recommendations.""",
    tools=[
        McpToolset(
        connection_params=StreamableHTTPConnectionParams(
            url = DEFAULT_MCP_URL,
            headers={"Authorization": f"Bearer {os.getenv("IBMI_MCP_ACCESS_TOKEN")}"},
        ),
        tool_filter=['system_status', 'system_activity', 'active_job_info',
                     'memory_pools', 'temp_storage_buckets', 'unnamed_temp_storage',
                     'http_server', 'collection_services', 'collection_categories',
                     'system_values'],
    ),
    ],
)