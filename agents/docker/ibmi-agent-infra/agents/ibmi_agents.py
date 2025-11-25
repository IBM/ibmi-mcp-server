"""
IBM i Specialized Agents Collection

This module defines a collection of specialized agno agents using FilteredMCPTools
for different IBM i system administration and monitoring tasks. Each agent is
configured with specific toolsets based on the prebuiltconfigs.

Available agents:
- Performance Agent: System performance monitoring and analysis
- SysAdmin Discovery Agent: High-level system discovery and summarization
- SysAdmin Browse Agent: Detailed system browsing and exploration
- SysAdmin Search Agent: System search and lookup capabilities
"""

from textwrap import dedent
from typing import Optional, Union

from agno.agent import Agent
from agno.models.base import Model
from agno.tools.reasoning import ReasoningTools

from agents.utils import FilteredMCPTools, get_model
from agents.agent_ids import AgentID
from infra.config_models import config
from infra.config_manager import AgentConfigManager
from infra.config_helper import apply_agent_config
from agents.base_agent import create_ibmi_agent


def get_performance_agent(
    model: Union[str, Model] = "openai:gpt-4o",
    mcp_url: str | None = None,
    transport: str | None = None,
    debug_filtering: bool = False,
    debug_mode: bool = False,
    enable_reasoning: bool = True,
    config_manager: Optional[AgentConfigManager] = None,
) -> Agent:
    """
    Create an IBM i Performance Monitoring Agent.

    This agent specializes in system performance analysis, monitoring CPU, memory,
    I/O metrics, and providing insights on system resource utilization.

    Args:
        model: Either a model string in format "provider:model_id" (e.g., "openai:gpt-4o",
               "watsonx:llama-3-3-70b-instruct") or a pre-configured Model instance
        mcp_url: MCP server URL
        transport: MCP transport type
        debug_filtering: Enable debug output for tool filtering
        debug_mode: Enable debug mode for the agent
        enable_reasoning: Enable reasoning tools for structured analysis (default: True)
        config_manager: Optional AgentConfigManager to load configuration from config.yaml.
                        When provided, overrides model, debug_mode, and enable_reasoning with config values.

    Examples:
        >>> # Using model string
        >>> agent = get_performance_agent("watsonx:llama-3-3-70b-instruct")

        >>> # Using config manager (recommended)
        >>> from infra.config_manager import AgentConfigManager
        >>> config_mgr = AgentConfigManager("infra/config.yaml")
        >>> agent = get_performance_agent(config_manager=config_mgr)
    """
    # Apply configuration from config_manager if provided
    model, debug_mode, enable_reasoning = apply_agent_config(
        agent_id=AgentID.IBMI_PERFORMANCE_MONITOR,
        config_manager=config_manager,
        model=model,
        debug_mode=debug_mode,
        enable_reasoning=enable_reasoning,
    )
    performance_tools = FilteredMCPTools(
        url=mcp_url or config.mcp.url,
        transport=transport or config.mcp.transport,
        annotation_filters={"toolsets": ["performance"]},
        debug_filtering=debug_filtering,
    )

    # Build tools list
    tools_list = [performance_tools]
    if enable_reasoning:
        tools_list.append(ReasoningTools(add_instructions=True))

    return create_ibmi_agent(
        id=AgentID.IBMI_PERFORMANCE_MONITOR,
        name="IBM i Performance Monitor",
        model=get_model(model),
        # Tools available to the agent
        tools=tools_list,
        # Description of the agent
        description=dedent(
            """\
            You are an IBM i Performance Monitoring Assistant specializing in system performance analysis and optimization.

            You help administrators monitor CPU, memory, I/O metrics, and provide actionable insights on system resource utilization.
        """
        ),
        # Instructions for the agent
        instructions=dedent(
            """\
            Your mission is to provide comprehensive performance monitoring and analysis for IBM i systems. Follow these steps:

            1. **Performance Assessment**
            - Use available tools to gather system status and activity data
            - Monitor memory pool utilization and temporary storage
            - Analyze HTTP server performance metrics
            - Track active jobs and CPU consumption patterns
            - Review system values and Collection Services configuration

            2. **Analysis & Insights** (Use reasoning tools when enabled)
            - Use think() to structure your analysis approach
            - Identify performance bottlenecks and resource constraints
            - Compare current metrics against normal operating ranges (use reasoning to compare)
            - Use analyze() to examine patterns and correlations in metrics
            - Explain what each metric means and why it's important
            - Provide context for when values are concerning vs. normal

            3. **Recommendations**
            - Use reasoning tools to evaluate multiple solutions
            - Deliver actionable optimization recommendations with priority levels
            - Explain performance data in business terms
            - Focus on insights rather than just presenting raw numbers
            - Help troubleshoot performance-related issues systematically
            - Provide step-by-step remediation plans

            4. **Communication**
            - Always explain what metrics you're checking and why
            - Structure responses for both quick understanding and detailed analysis
            - Use clear, non-technical language when explaining to non-experts
            - Show your reasoning process for complex diagnostics

            Additional Information:
            - You are interacting with the user_id: {current_user_id}
            - The user's name might be different from the user_id, you may ask for it if needed and add it to your memory if they share it with you.\
        """
        ),
        debug_mode=debug_mode,
    )


def get_sysadmin_discovery_agent(
    model: Union[str, Model] = "openai:gpt-4o",
    mcp_url: str | None = None,
    transport: str | None = None,
    debug_filtering: bool = False,
    debug_mode: bool = False,
    enable_reasoning: bool = True,
    config_manager: Optional[AgentConfigManager] = None,
) -> Agent:
    """
    Create an IBM i System Administration Discovery Agent.

    This agent specializes in high-level system discovery, providing summaries
    and counts of system services and components.

    Args:
        model: Either a model string in format "provider:model_id" (e.g., "openai:gpt-4o",
               "watsonx:llama-3-3-70b-instruct") or a pre-configured Model instance
        mcp_url: MCP server URL
        transport: MCP transport type
        debug_filtering: Enable debug output for tool filtering
        debug_mode: Enable debug mode for the agent
        enable_reasoning: Enable reasoning tools for structured analysis (default: True)
        config_manager: Optional AgentConfigManager to load configuration from config.yaml.
                        When provided, overrides model, debug_mode, and enable_reasoning with config values.
    """
    # Apply configuration from config_manager if provided
    model, debug_mode, enable_reasoning = apply_agent_config(
        agent_id=AgentID.IBMI_SYSADMIN_DISCOVERY,
        config_manager=config_manager,
        model=model,
        debug_mode=debug_mode,
        enable_reasoning=enable_reasoning,
    )
    discovery_tools = FilteredMCPTools(
        url=mcp_url or config.mcp.url,
        transport=transport or config.mcp.transport,
        annotation_filters={"toolsets": ["sysadmin_discovery"]},
        debug_filtering=debug_filtering,
    )

    # Build tools list
    tools_list = [discovery_tools]
    if enable_reasoning:
        tools_list.append(ReasoningTools(add_instructions=True))

    return create_ibmi_agent(
        id=AgentID.IBMI_SYSADMIN_DISCOVERY,
        name="IBM i SysAdmin Discovery",
        model=get_model(model),
        # Tools available to the agent
        tools=tools_list,
        # Description of the agent
        description=dedent(
            """\
            You are an IBM i System Administration Discovery Assistant specializing in high-level system analysis.

            You help administrators understand the scope and organization of system services through summaries and inventories.
        """
        ),
        # Instructions for the agent
        instructions=dedent(
            """\
            Your mission is to provide comprehensive system discovery and overview capabilities for IBM i systems. Follow these steps:

            1. **System Discovery**
            - Generate service category listings and counts
            - Provide schema-based service summaries (QSYS2, SYSTOOLS, etc.)
            - Categorize services by SQL object types (VIEW, PROCEDURE, FUNCTION)
            - Enable cross-referencing capabilities across system components

            2. **Inventory & Organization**
            - Deliver high-level system overviews and inventories
            - Help administrators understand what's available on their system
            - Summarize components by category, schema, and type
            - Use counts and categorizations to convey system complexity

            3. **Pattern Recognition**
            - Identify patterns and relationships in system organization
            - Highlight logical groupings and dependencies
            - Show how components relate to each other

            4. **Communication**
            - Provide clear, organized summaries
            - Use structured formats for easy scanning
            - Give context about what the numbers mean
            - Suggest logical next steps for exploration

            Additional Information:
            - You are interacting with the user_id: {current_user_id}
            - The user's name might be different from the user_id, you may ask for it if needed and add it to your memory if they share it with you.\
        """
        ),
        debug_mode=debug_mode,
    )


def get_sysadmin_browse_agent(
    model: Union[str, Model] = "openai:gpt-4o",
    mcp_url: str | None = None,
    transport: str | None = None,
    debug_filtering: bool = False,
    debug_mode: bool = False,
    enable_reasoning: bool = True,
    config_manager: Optional[AgentConfigManager] = None,
) -> Agent:
    """
    Create an IBM i System Administration Browse Agent.

    This agent specializes in detailed browsing and exploration of system services,
    allowing deep dives into specific categories, schemas, and object types.

    Args:
        model: Either a model string in format "provider:model_id" (e.g., "openai:gpt-4o",
               "watsonx:llama-3-3-70b-instruct") or a pre-configured Model instance
        mcp_url: MCP server URL
        transport: MCP transport type
        debug_filtering: Enable debug output for tool filtering
        debug_mode: Enable debug mode for the agent
        enable_reasoning: Enable reasoning tools for structured analysis (default: True)
        config_manager: Optional AgentConfigManager to load configuration from config.yaml.
                        When provided, overrides model, debug_mode, and enable_reasoning with config values.
    """
    # Apply configuration from config_manager if provided
    model, debug_mode, enable_reasoning = apply_agent_config(
        agent_id=AgentID.IBMI_SYSADMIN_BROWSE,
        config_manager=config_manager,
        model=model,
        debug_mode=debug_mode,
        enable_reasoning=enable_reasoning,
    )
    browse_tools = FilteredMCPTools(
        url=mcp_url or config.mcp.url,
        transport=transport or config.mcp.transport,
        annotation_filters={"toolsets": ["sysadmin_browse"]},
        debug_filtering=debug_filtering,
    )

    # Build tools list
    tools_list = [browse_tools]
    if enable_reasoning:
        tools_list.append(ReasoningTools(add_instructions=True))

    return create_ibmi_agent(
        id=AgentID.IBMI_SYSADMIN_BROWSE,
        name="IBM i SysAdmin Browser",
        model=get_model(model),
        # Tools available to the agent
        tools=tools_list,
        # Description of the agent
        description=dedent(
            """\
            You are an IBM i System Administration Browse Assistant specializing in detailed system exploration.

            You help administrators explore and examine system services in depth across categories, schemas, and object types.
        """
        ),
        # Instructions for the agent
        instructions=dedent(
            """\
            Your mission is to provide detailed browsing and exploration capabilities for IBM i system services. Follow these steps:

            1. **Detailed Browsing**
            - List services by specific categories
            - Explore services within specific schemas (QSYS2, SYSTOOLS, etc.)
            - Filter services by SQL object type (VIEW, PROCEDURE, FUNCTION, etc.)
            - Provide detailed service metadata and compatibility information

            2. **Deep Exploration**
            - Help administrators explore specific areas of interest in depth
            - Provide comprehensive listings with metadata for system services
            - Explain service compatibility and release requirements
            - Guide users through logical browsing paths

            3. **Technical Guidance**
            - Explain technical concepts like SQL object types
            - Clarify release compatibility and version requirements
            - Describe service capabilities and use cases
            - Provide context for service relationships

            4. **Navigation Support**
            - Suggest related services based on current exploration
            - Recommend logical next steps in their browsing journey
            - Help users understand the details of what they find
            - Create coherent exploration narratives

            Additional Information:
            - You are interacting with the user_id: {current_user_id}
            - The user's name might be different from the user_id, you may ask for it if needed and add it to your memory if they share it with you.\
        """
        ),
        debug_mode=debug_mode,
    )


def get_sysadmin_search_agent(
    model: Union[str, Model] = "openai:gpt-4o",
    mcp_url: str | None = None,
    transport: str | None = None,
    debug_filtering: bool = False,
    debug_mode: bool = False,
    enable_reasoning: bool = True,
    config_manager: Optional[AgentConfigManager] = None,
) -> Agent:
    """
    Create an IBM i System Administration Search Agent.

    This agent specializes in searching and lookup capabilities, helping users
    find specific services, examples, and usage patterns.

    Args:
        model: Either a model string in format "provider:model_id" (e.g., "openai:gpt-4o",
               "watsonx:llama-3-3-70b-instruct") or a pre-configured Model instance
        mcp_url: MCP server URL
        transport: MCP transport type
        debug_filtering: Enable debug output for tool filtering
        debug_mode: Enable debug mode for the agent
        enable_reasoning: Enable reasoning tools for structured analysis (default: True)
        config_manager: Optional AgentConfigManager to load configuration from config.yaml.
                        When provided, overrides model, debug_mode, and enable_reasoning with config values.
    """
    # Apply configuration from config_manager if provided
    model, debug_mode, enable_reasoning = apply_agent_config(
        agent_id=AgentID.IBMI_SYSADMIN_SEARCH,
        config_manager=config_manager,
        model=model,
        debug_mode=debug_mode,
        enable_reasoning=enable_reasoning,
    )
    search_tools = FilteredMCPTools(
        url=mcp_url or config.mcp.url,
        transport=transport or config.mcp.transport,
        annotation_filters={"toolsets": ["sysadmin_search"]},
        debug_filtering=debug_filtering,
    )

    # Build tools list
    tools_list = [search_tools]
    if enable_reasoning:
        tools_list.append(ReasoningTools(add_instructions=True))

    return create_ibmi_agent(
        id=AgentID.IBMI_SYSADMIN_SEARCH,
        name="IBM i SysAdmin Search",
        model=get_model(model),
        # Tools available to the agent
        tools=tools_list,
        # Description of the agent
        description=dedent(
            """\
            You are an IBM i System Administration Search Assistant specializing in finding specific services and usage information.

            You help administrators quickly locate services, examples, and documentation across the system.
        """
        ),
        # Instructions for the agent
        instructions=dedent(
            """\
            Your mission is to provide powerful search and lookup capabilities for IBM i system services. Follow these steps:

            1. **Comprehensive Search**
            - Perform case-insensitive service name searches
            - Locate services across all schemas
            - Search through example code and usage patterns
            - Retrieve specific service examples and documentation

            2. **Targeted Results**
            - Help users find exactly what they're looking for quickly
            - Provide exact service locations and metadata
            - Search through documentation and examples for keywords
            - Filter results to most relevant matches

            3. **Result Interpretation**
            - When showing examples, explain the context and provide usage guidance
            - If multiple matches are found, help users understand the differences
            - Clarify which result best matches their needs
            - Provide additional context for understanding results

            4. **Search Optimization**
            - Suggest related searches or alternative terms when searches yield few results
            - Offer refined search strategies if initial searches are too broad
            - Help users learn effective search patterns
            - Guide users to related or similar services

            Additional Information:
            - You are interacting with the user_id: {current_user_id}
            - The user's name might be different from the user_id, you may ask for it if needed and add it to your memory if they share it with you.\
        """
        ),
        debug_mode=debug_mode,
    )


# Agent instances for direct import
performance_agent = get_performance_agent()
discovery_agent = get_sysadmin_discovery_agent()
browse_agent = get_sysadmin_browse_agent()
search_agent = get_sysadmin_search_agent()
