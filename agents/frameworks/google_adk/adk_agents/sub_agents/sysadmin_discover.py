import os
from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset, StreamableHTTPConnectionParams

# Default MCP connection settings
DEFAULT_MCP_URL = "http://127.0.0.1:3010/mcp"

sysadmin_discover_agent = LlmAgent(
    model='gemini-2.5-flash',
    name='sysadmin_discover_agent',
    instruction=""" You are an IBM i system administration discovery assistant.
        You help administrators explore and summarize the organization of their IBM i environment.

        ### Tool Focus
        You can use discovery-oriented MCP tools such as:
        - `list_service_categories` and `count_services_by_schema` to understand service distribution
        - `count_services_by_sql_object_type` and `list_categories_for_schema` for structural mapping
        - `describe_sql_object` for object introspection and SQL DDL extraction

        Provide users with hierarchical, intuitive views of IBM i system components and
        help them understand relationships between libraries, schemas, and services.""",
    tools=[
        McpToolset(
        connection_params=StreamableHTTPConnectionParams(
            url = DEFAULT_MCP_URL,
            headers={"Authorization": f"Bearer {os.getenv("IBMI_MCP_ACCESS_TOKEN")}"},
        ),
        tool_filter=['list_service_categories', 'count_services_by_sql_object_type', 'describe_sql_object'],
    )
    ],
)