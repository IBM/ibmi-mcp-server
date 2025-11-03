"""
FilteredMCPTools - Google ADK version with annotation-based filtering

This module provides filtering capabilities for MCP tools in Google ADK,
including annotation-based filtering and convenience factory functions.
Supports both streamable_http and stdio transports.
"""

import os
from typing import Optional, List, Dict, Any, Union, Callable, Literal
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.base_toolset import ToolPredicate
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset, StreamableHTTPConnectionParams
from google.adk.tools.mcp_tool.mcp_session_manager import StdioConnectionParams
from google.adk.auth.auth_credential import AuthCredential, AuthCredentialTypes, HttpAuth, HttpCredentials
from fastapi.openapi.models import HTTPBearer
from mcp import StdioServerParameters


# Default MCP connection settings
DEFAULT_MCP_URL = "http://127.0.0.1:3010/mcp"
DEFAULT_TRANSPORT = "streamable_http"

# ============================================================
#  Helper Functions for Annotation Filtering
# ============================================================

def _get_annotation_value(tool: BaseTool, annotation_key: str) -> Any:
    """
    Extract annotation value from a Google ADK MCP tool.
    
    Args:
        tool: Google ADK BaseTool object
        annotation_key: Name of the annotation to extract (e.g., 'toolsets', 'readOnlyHint')
        
    Returns:
        The annotation value, or None if annotation doesn't exist.
    """
    try:
        annotations = getattr(tool.raw_mcp_tool, "annotations", None)
        if not annotations:
            return None
        return annotations.model_dump().get(annotation_key, None)
    except Exception:
        return None


def _annotation_matches_filter(annotation_value: Any, filter_value: Any) -> bool:
    """
    Check if annotation value matches the filter criteria.
    
    Filter types supported:
    - Primitive (str/bool/int): Exact match
    - List: OR logic - annotation must be in list or lists must intersect
    - Callable: filter_value(annotation_value) must return True
    """
    if callable(filter_value):
        try:
            return bool(filter_value(annotation_value))
        except Exception:
            return False
    
    if isinstance(filter_value, list):
        if isinstance(annotation_value, list):
            # List annotation: check if any annotation values match any filter values
            return bool(set(annotation_value) & set(filter_value))
        else:
            # Single annotation: check if it's in the filter list
            return annotation_value in filter_value
    
    # Primitive exact match
    return annotation_value == filter_value


# ============================================================
#  Tool Predicate Functions
# ============================================================

def toolset_filter_predicate(
    allowed_toolsets: List[str],
    debug: bool = False
) -> ToolPredicate:
    """
    Returns a ToolPredicate that filters tools based on their annotated toolsets.

    Args:
        allowed_toolsets: List of toolset names (e.g. ["performance", "sys_admin"])
        debug: Whether to print filtering debug information

    Returns:
        A ToolPredicate function.
    """
    def _predicate(tool: BaseTool, readonly_context: Optional[ReadonlyContext] = None) -> bool:
        try:
            toolsets = _get_annotation_value(tool, "toolsets")
            if not toolsets:
                if debug:
                    print(f"[ToolPredicate] ✗ Excluding {tool.name}: no toolsets annotation")
                return False

            # Allow the tool if any of its toolsets match allowed ones
            matches = any(ts in allowed_toolsets for ts in toolsets)
            if debug:
                if matches:
                    print(f"[ToolPredicate] ✓ Including {tool.name}: toolsets={toolsets}")
                else:
                    print(f"[ToolPredicate] ✗ Excluding {tool.name}: toolsets={toolsets}")
            return matches

        except Exception as e:
            if debug:
                print(f"[ToolPredicate] Error filtering {getattr(tool, 'name', 'unknown')}: {e}")
            return False

    return _predicate


def annotation_filter_predicate(
    annotation_filters: Dict[str, Union[Any, List[Any], Callable]],
    debug: bool = False
) -> ToolPredicate:
    """
    Returns a ToolPredicate that filters tools based on multiple annotations.
    
    Args:
        annotation_filters: Dict mapping annotation names to filter values
        debug: Whether to print filtering debug information
        
    Returns:
        A ToolPredicate function.
        
    Example:
        predicate = annotation_filter_predicate({
            "toolsets": ["performance"],
            "readOnlyHint": True,
        })
    """
    def _predicate(tool: BaseTool, readonly_context: Optional[ReadonlyContext] = None) -> bool:
        try:
            # Apply all annotation filters (AND logic)
            for annotation_key, filter_value in annotation_filters.items():
                annotation_value = _get_annotation_value(tool, annotation_key)
                
                if not _annotation_matches_filter(annotation_value, filter_value):
                    if debug:
                        print(f"[ToolPredicate] ✗ Excluding {tool.name}: {annotation_key}={annotation_value}")
                    return False
            
            if debug:
                print(f"[ToolPredicate] ✓ Including {tool.name}")
            return True

        except Exception as e:
            if debug:
                print(f"[ToolPredicate] Error filtering {getattr(tool, 'name', 'unknown')}: {e}")
            return False

    return _predicate


# ============================================================
#  Main Loading Functions
# ============================================================

async def load_filtered_mcp_tools(
    annotation_filters: Optional[Dict[str, Union[Any, List[Any], Callable]]] = None,
    custom_filter: Optional[Callable] = None,
    transport: Literal["streamable_http", "stdio"] = DEFAULT_TRANSPORT,
    url: Optional[str] = None,
    token: Optional[str] = None,
    command: Optional[str] = None,
    args: Optional[List[str]] = None,
    env: Optional[Dict[str, str]] = None,
    debug: bool = False,
) -> McpToolset:
    """
    Load MCP tools with annotation-based filtering.
    
    Supports both streamable_http and stdio transports.
    
    Args:
        annotation_filters: Dict mapping annotation names to filter values
        custom_filter: Optional custom function(tool) -> bool for complex filtering
        transport: Connection transport type ("streamable_http" or "stdio")
        url: MCP server URL (for streamable_http transport)
        token: Bearer token (for streamable_http, default: from IBMI_MCP_ACCESS_TOKEN env var)
        command: Command to run MCP server (for stdio transport, e.g., "npx")
        args: Arguments for the command (for stdio transport)
        env: Environment variables for the command (for stdio transport)
        debug: Whether to print filtering debug information
        
    Returns:
        Configured McpToolset instance
        
    Examples:
        # Streamable HTTP with filtering
        toolset = await load_filtered_mcp_tools(
            annotation_filters={"toolsets": ["performance"]},
            transport="streamable_http",
            url="http://127.0.0.1:3010/mcp"
        )
        
        # Stdio with filtering
        toolset = await load_filtered_mcp_tools(
            annotation_filters={"readOnlyHint": True},
            transport="stdio",
            command="npx",
            args=["ibmi-mcp-server"],
            env={"DB2i_HOST": "localhost", "DB2i_USER": "user"}
        )
    """
    if debug:
        print(f"[FilteredMCPTools] Using {transport} transport")
    
    # Create filter predicate if needed
    tool_filter = None
    if annotation_filters:
        tool_filter = annotation_filter_predicate(annotation_filters, debug=debug)
    elif custom_filter:
        # Wrap custom filter in a predicate
        def _custom_predicate(tool: BaseTool, readonly_context: Optional[ReadonlyContext] = None) -> bool:
            try:
                return custom_filter(tool)
            except Exception as e:
                if debug:
                    print(f"[FilteredMCPTools] Custom filter error for {tool.name}: {e}")
                return False
        tool_filter = _custom_predicate
    
    # Create toolset based on transport type
    if transport == "streamable_http":
        # Get token for HTTP transport
        if token is None:
            token = os.getenv("IBMI_MCP_ACCESS_TOKEN")
        if not token:
            raise ValueError("Missing IBMI_MCP_ACCESS_TOKEN in environment variables for streamable_http transport.")
        
        if url is None:
            url = DEFAULT_MCP_URL
        
        if debug:
            print(f"[FilteredMCPTools] Connecting to {url}")
        
        # Set up authentication
        auth_scheme = HTTPBearer(
            scheme="bearer",
            bearerFormat="JWT",
            description="Bearer token authentication for IBM i MCP server."
        )
        
        http_credentials = HttpCredentials(token=token)
        http_auth = HttpAuth(scheme="bearer", credentials=http_credentials)
        auth_credential = AuthCredential(
            auth_type=AuthCredentialTypes.HTTP,
            http=http_auth,
        )
        
        toolset = McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url=url,
                headers={"Authorization": f"Bearer {token}"},
            ),
            auth_scheme=auth_scheme,
            auth_credential=auth_credential,
            tool_filter=tool_filter,
        )
    
    elif transport == "stdio":
        # Validate stdio parameters
        if command is None:
            raise ValueError("command parameter is required for stdio transport")
        
        if debug:
            print(f"[FilteredMCPTools] Running command: {command} {' '.join(args or [])}")
        
        # Create stdio connection
        server_params = StdioServerParameters(
            command=command,
            args=args or [],
            env=env or {}
        )
        
        toolset = McpToolset(
            connection_params=StdioConnectionParams(
                server_params=server_params
            ),
            tool_filter=tool_filter,
        )
    
    else:
        raise ValueError(f"Unsupported transport type: {transport}. Must be 'streamable_http' or 'stdio'.")
    
    if debug:
        print("[FilteredMCPTools] McpToolset created successfully")
        tools = await toolset.get_tools()
        print(f"[FilteredMCPTools] Loaded {len(tools)} tools")
        for tool in tools:
            print(f"  - {tool.name}: {tool.description}")
    
    return toolset


# ============================================================
#  Convenience Factory Functions
# ============================================================

async def load_toolset_tools(
    toolsets: Union[str, List[str]],
    transport: Literal["streamable_http", "stdio"] = DEFAULT_TRANSPORT,
    url: Optional[str] = None,
    token: Optional[str] = None,
    command: Optional[str] = None,
    args: Optional[List[str]] = None,
    env: Optional[Dict[str, str]] = None,
    debug: bool = False,
) -> McpToolset:
    """
    Load MCP tools filtered by toolset annotation.
    
    Args:
        toolsets: Single toolset string or list of toolsets. If an empty list is provided,
                  no tools will match the filter (returns empty toolset).
        transport: Connection transport type ("streamable_http" or "stdio")
        url: MCP server URL (for streamable_http)
        token: Bearer token (for streamable_http)
        command: Command to run MCP server (for stdio)
        args: Arguments for the command (for stdio)
        env: Environment variables (for stdio)
        debug: Whether to print debug information
        
    Returns:
        Configured McpToolset instance filtered by toolsets
        
    Raises:
        ValueError: If an empty list is provided for toolsets parameter
        
    Examples:
        # HTTP transport with single toolset
        toolset = await load_toolset_tools("performance")
        
        # HTTP transport with multiple toolsets
        toolset = await load_toolset_tools(["performance", "sys_admin"])
        
        # Stdio transport
        toolset = await load_toolset_tools(
            "performance",
            transport="stdio",
            command="npx",
            args=["ibmi-mcp-server"]
        )
        
    Note:
        Passing an empty list for toolsets will raise a ValueError since it would
        create a filter that matches no tools. If you want to load all tools without
        filtering, use load_filtered_mcp_tools() with no annotation_filters instead.
    """
    # Convert single string to list
    toolsets_list = [toolsets] if isinstance(toolsets, str) else list(toolsets)
    
    # Explicitly handle empty list edge case
    if not toolsets_list:
        raise ValueError(
            "Empty toolsets list provided. This would create a filter that matches no tools. "
            "To load all tools without filtering, use load_filtered_mcp_tools() instead."
        )
    
    return await load_filtered_mcp_tools(
        annotation_filters={"toolsets": toolsets_list},
        transport=transport,
        url=url,
        token=token,
        command=command,
        args=args,
        env=env,
        debug=debug,
    )


async def load_readonly_tools(
    transport: Literal["streamable_http", "stdio"] = DEFAULT_TRANSPORT,
    url: Optional[str] = None,
    token: Optional[str] = None,
    command: Optional[str] = None,
    args: Optional[List[str]] = None,
    env: Optional[Dict[str, str]] = None,
    debug: bool = False,
) -> McpToolset:
    """Load only read-only tools (using MCP standard annotation)."""
    return await load_filtered_mcp_tools(
        annotation_filters={"readOnlyHint": True},
        transport=transport,
        url=url,
        token=token,
        command=command,
        args=args,
        env=env,
        debug=debug,
    )


async def load_non_destructive_tools(
    transport: Literal["streamable_http", "stdio"] = DEFAULT_TRANSPORT,
    url: Optional[str] = None,
    token: Optional[str] = None,
    command: Optional[str] = None,
    args: Optional[List[str]] = None,
    env: Optional[Dict[str, str]] = None,
    debug: bool = False,
) -> McpToolset:
    """Load only non-destructive tools (using MCP standard annotation)."""
    return await load_filtered_mcp_tools(
        annotation_filters={"destructiveHint": False},
        transport=transport,
        url=url,
        token=token,
        command=command,
        args=args,
        env=env,
        debug=debug,
    )


async def load_closed_world_tools(
    transport: Literal["streamable_http", "stdio"] = DEFAULT_TRANSPORT,
    url: Optional[str] = None,
    token: Optional[str] = None,
    command: Optional[str] = None,
    args: Optional[List[str]] = None,
    env: Optional[Dict[str, str]] = None,
    debug: bool = False,
) -> McpToolset:
    """Load only closed-world tools (using MCP standard annotation)."""
    return await load_filtered_mcp_tools(
        annotation_filters={"openWorldHint": False},
        transport=transport,
        url=url,
        token=token,
        command=command,
        args=args,
        env=env,
        debug=debug,
    )


async def load_safe_tools(
    transport: Literal["streamable_http", "stdio"] = DEFAULT_TRANSPORT,
    url: Optional[str] = None,
    token: Optional[str] = None,
    command: Optional[str] = None,
    args: Optional[List[str]] = None,
    env: Optional[Dict[str, str]] = None,
    debug: bool = False,
) -> McpToolset:
    """Load safe tools (read-only, non-destructive, closed-world)."""
    return await load_filtered_mcp_tools(
        annotation_filters={
            "readOnlyHint": True,
            "destructiveHint": False,
            "openWorldHint": False,
        },
        transport=transport,
        url=url,
        token=token,
        command=command,
        args=args,
        env=env,
        debug=debug,
    )


# ============================================================
#  Legacy Compatibility
# ============================================================

async def load_mcp_tools(tool_filter=None):
    """
    Legacy function for backward compatibility.
    
    Load tools from a local MCP server with Bearer token authentication.
    
    Args:
        tool_filter: Single toolset name (string) for filtering
        
    Returns:
        Configured McpToolset instance
        
    Note:
        This function is maintained for backward compatibility.
        New code should use load_toolset_tools() or load_filtered_mcp_tools().
    """
    if tool_filter:
        return await load_toolset_tools(tool_filter)
    else:
        return await load_filtered_mcp_tools()
