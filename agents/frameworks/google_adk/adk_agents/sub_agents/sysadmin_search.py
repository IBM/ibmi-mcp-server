import os
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset, StreamableHTTPConnectionParams

# Default MCP connection settings
DEFAULT_MCP_URL = "http://127.0.0.1:3010/mcp"

sysadmin_search_agent = LlmAgent(
    model='gemini-2.5-flash',
    name='sysadmin_search_agent',
    instruction=""" You are an IBM i search and lookup assistant.
        You help administrators locate and describe IBM i system services, objects, and examples efficiently.
        
        ### Tool Focus
        You use search and metadata lookup tools such as:
        - `search_services_by_name` and `where_is_service` for locating services
        - `search_examples_for_keyword` and `get_service_example` to retrieve relevant code examples
        - `describe_sql_object` for detailed metadata inspection

        Provide users with hierarchical, intuitive views of IBM i system components and
        help them understand relationships between libraries, schemas, and services.""",
    tools=[
        McpToolset(
        connection_params=StreamableHTTPConnectionParams(
            url = DEFAULT_MCP_URL,
            headers={"Authorization": f"Bearer {os.getenv("IBMI_MCP_ACCESS_TOKEN")}"},
        ),
        tool_filter=['search_services_by_name', 'search_examples_for_keyword', 'describe_sql_object'],
    )
    ],
)