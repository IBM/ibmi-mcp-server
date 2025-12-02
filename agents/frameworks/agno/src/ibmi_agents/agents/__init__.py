"""
IBM i Agents Collection

This module exports all IBM i specialized agents and supporting utilities.
"""

from .agent_ids import AgentID
from .base_agent import create_ibmi_agent, get_shared_db
from .ibmi_agents import (
    DEFAULT_MCP_URL,
    DEFAULT_TRANSPORT,
    browse_agent,
    create_performance_agent,
    create_sysadmin_browse_agent,
    create_sysadmin_discovery_agent,
    create_sysadmin_search_agent,
    discovery_agent,
    get_performance_agent,
    get_sysadmin_browse_agent,
    get_sysadmin_discovery_agent,
    get_sysadmin_search_agent,
    performance_agent,
    search_agent,
)
from .web_agent import get_web_agent
from .agno_assist import get_agno_assist, agno_assist
from .utils import get_model, get_model_by_alias, parse_model_spec, COMMON_MODELS

__all__ = [
    # Agent IDs
    "AgentID",
    # Base utilities
    "create_ibmi_agent",
    "get_shared_db",
    # Default connection settings
    "DEFAULT_MCP_URL",
    "DEFAULT_TRANSPORT",
    # Model utilities
    "get_model",
    "get_model_by_alias",
    "parse_model_spec",
    "COMMON_MODELS",
    # IBM i Agents - Factory functions (new naming convention)
    "get_performance_agent",
    "get_sysadmin_discovery_agent",
    "get_sysadmin_browse_agent",
    "get_sysadmin_search_agent",
    # IBM i Agents - Legacy factory functions (backward compatibility)
    "create_performance_agent",
    "create_sysadmin_discovery_agent",
    "create_sysadmin_browse_agent",
    "create_sysadmin_search_agent",
    # IBM i Agents - Pre-instantiated instances
    "performance_agent",
    "discovery_agent",
    "browse_agent",
    "search_agent",
    # Other agents
    "get_web_agent",
    "get_agno_assist",
    "agno_assist",
]
