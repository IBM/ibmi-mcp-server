"""
IBM i Specialized Agents Collection - LangGraph Implementation

This module provides specialized LangGraph agents for different IBM i system
administration and monitoring tasks.

Available agents:
- Performance Agent: System performance monitoring and analysis
- SysAdmin Discovery Agent: High-level system discovery and summarization
- SysAdmin Browse Agent: Detailed system browsing and exploration
- SysAdmin Search Agent: System search and lookup capabilities
- Security Operations Agent: Security vulnerability assessment and remediation
"""

from .ibmi_agents import (
    create_ibmi_agent,
    create_performance_agent,
    create_sysadmin_discovery_agent,
    create_sysadmin_browse_agent,
    create_sysadmin_search_agent,
    create_security_ops_agent,
    chat_with_agent,
    list_available_agents,
    set_verbose_logging,
    get_verbose_logging,
    AVAILABLE_AGENTS
)

__all__ = [
    "create_ibmi_agent",
    "create_performance_agent",
    "create_sysadmin_discovery_agent",
    "create_sysadmin_browse_agent",
    "create_sysadmin_search_agent",
    "create_security_ops_agent",
    "chat_with_agent",
    "list_available_agents",
    "set_verbose_logging",
    "get_verbose_logging",
    "AVAILABLE_AGENTS"
]


