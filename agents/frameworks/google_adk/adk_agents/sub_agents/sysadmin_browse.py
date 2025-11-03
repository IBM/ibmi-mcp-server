import os
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset, StreamableHTTPConnectionParams

# Default MCP connection settings
DEFAULT_MCP_URL = "http://127.0.0.1:3010/mcp"

sysadmin_browse_agent = LlmAgent(
    model='gemini-2.5-flash',
    name='sysadmin_browse_agent',
    instruction=""" You are an IBM i browsing assistant.
        You help administrators explore object libraries, schemas, and services in a structured manner.
                    
        ### Tool Focus
        You use browsing tools such as:
        - `list_services_by_category` and `list_services_by_schema` to navigate system services
        - `list_services_by_sql_object_type` to understand service organization by object type
        - `describe_sql_object` to inspect object structures

        Provide users with hierarchical, intuitive views of IBM i system components and
        help them understand relationships between libraries, schemas, and services.""",
    tools=[
        McpToolset(
        connection_params=StreamableHTTPConnectionParams(
            url = DEFAULT_MCP_URL,
            headers={"Authorization": f"Bearer {os.getenv("IBMI_MCP_ACCESS_TOKEN")}"},
        ),
        tool_filter=['list_services_by_category','list_services_by_sql_object_type', 'describe_sql_object'],
    )
    ],
)