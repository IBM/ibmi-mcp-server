from ibmi_agent_sdk.google_adk import load_toolset_tools
import os

def build_toolset_kwargs(debug_filtering: bool = False) -> dict:
    """
    Build kwargs for load_toolset_tools based on transport type from environment.
    
    Args:
        debug_filtering: Enable debug output for tool filtering
        
    Returns:
        dict: Kwargs to pass to load_toolset_tools
        
    Raises:
        ValueError: If HTTP transport is selected but token is missing
    """
    # Get transport type from environment
    transport = os.getenv("MCP_TRANSPORT_TYPE", "stdio")
    
    # Build base kwargs
    toolset_kwargs = {
        "debug": debug_filtering,
        "transport": transport
    }
    
    if transport == "stdio":
        env = {
            "DB2i_HOST": os.getenv("DB2i_HOST", ""),
            "DB2i_USER": os.getenv("DB2i_USER", ""),
            "DB2i_PASS": os.getenv("DB2i_PASS", ""),
            "DB2i_PORT": os.getenv("DB2i_PORT", "8076"),
            "MCP_TRANSPORT_TYPE": transport,
            "YAML_ALLOW_DUPLICATE_SOURCES": "true",
            "TOOLS_YAML_PATH": os.getenv("TOOLS_YAML_PATH", "tools"),
        }
        toolset_kwargs.update({
            "command": "npx",
            "args":["ibmi-mcp-server"],
            "env": env
        })
    elif transport == "http":
        token = os.getenv("IBMI_MCP_ACCESS_TOKEN")
        if not token:
            raise ValueError("IBMI_MCP_ACCESS_TOKEN is required for HTTP transport")
        toolset_kwargs["token"] = token
        toolset_kwargs["transport"] = "streamable_http"

    return toolset_kwargs

def get_performance_tools(debug_filtering):
    toolset_kwargs = build_toolset_kwargs(debug_filtering)
    toolset = load_toolset_tools("performance", **toolset_kwargs)
    return toolset

def get_search_tools(debug_filtering):
    toolset_kwargs = build_toolset_kwargs(debug_filtering)
    toolset = load_toolset_tools("sysadmin_search", **toolset_kwargs)
    return toolset

def get_browse_tools(debug_filtering):
    toolset_kwargs = build_toolset_kwargs(debug_filtering)
    toolset = load_toolset_tools("sysadmin_browse", **toolset_kwargs)
    return toolset

def get_discovery_tools(debug_filtering):
    toolset_kwargs = build_toolset_kwargs(debug_filtering)
    toolset = load_toolset_tools("sysadmin_discovery", **toolset_kwargs)
    return toolset

def get_security_tools(debug_filtering):
    toolset_kwargs = build_toolset_kwargs(debug_filtering)
    toolset = load_toolset_tools(["security_audit", "security_vulnerability_assessment", "security_remediation", "library_list_configuration", "library_list_security", "library_list_security_assessment"], 
        **toolset_kwargs)
    return toolset
