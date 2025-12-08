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

from agno.agent import Agent

from agents.agent_ids import AgentID
from agents.builder import AgentBuilder
from agents.config import AgentRunConfig
from agents.registry import register_agent, AgentMetadata


@register_agent(
    AgentMetadata(
        id="performance",
        name="IBM i Performance Monitor",
        description="System performance monitoring and analysis for CPU, memory, I/O metrics",
        category="ibmi",
        tags=["performance", "monitoring", "cpu", "memory"],
    )
)
def get_performance_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    """
    Create an IBM i Performance Monitoring Agent.

    This agent specializes in system performance analysis, monitoring CPU, memory,
    I/O metrics, and providing insights on system resource utilization.

    Args:
        config: Agent runtime configuration (model, debug, tools, etc.)

    Returns:
        Configured Agent instance

    Examples:
        >>> # Basic usage
        >>> agent = get_performance_agent()

        >>> # With custom model
        >>> config = AgentRunConfig(model="watsonx:llama-3-3-70b-instruct")
        >>> agent = get_performance_agent(config)

        >>> # With config file
        >>> from infra.config_manager import AgentConfigManager
        >>> config = AgentRunConfig(config_manager=AgentConfigManager("infra/config.yaml"))
        >>> agent = get_performance_agent(config)
    """
    return (
        AgentBuilder(AgentID.IBMI_PERFORMANCE_MONITOR, "IBM i Performance Monitor")
        .with_description(dedent("""\
            You are an IBM i Performance Monitoring Assistant specializing in system performance analysis and optimization.

            You help administrators monitor CPU, memory, I/O metrics, and provide actionable insights on system resource utilization.
        """))
        .with_instructions(dedent("""\
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
        """))
        .with_toolsets("performance")
        .build(config)
    )


@register_agent(
    AgentMetadata(
        id="sysadmin-discovery",
        name="IBM i SysAdmin Discovery",
        description="High-level system discovery and summarization of services and components",
        category="ibmi",
        tags=["sysadmin", "discovery", "inventory"],
    )
)
def get_sysadmin_discovery_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    """
    Create an IBM i System Administration Discovery Agent.

    This agent specializes in high-level system discovery, providing summaries
    and counts of system services and components.

    Args:
        config: Agent runtime configuration (model, debug, tools, etc.)

    Returns:
        Configured Agent instance
    """
    return (
        AgentBuilder(AgentID.IBMI_SYSADMIN_DISCOVERY, "IBM i SysAdmin Discovery")
        .with_description(dedent("""\
            You are an IBM i System Administration Discovery Assistant specializing in high-level system analysis.

            You help administrators understand the scope and organization of system services through summaries and inventories.
        """))
        .with_instructions(dedent("""\
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
        """))
        .with_toolsets("sysadmin_discovery")
        .build(config)
    )


@register_agent(
    AgentMetadata(
        id="sysadmin-browse",
        name="IBM i SysAdmin Browser",
        description="Detailed browsing and exploration of system services by category and schema",
        category="ibmi",
        tags=["sysadmin", "browse", "exploration"],
    )
)
def get_sysadmin_browse_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    """
    Create an IBM i System Administration Browse Agent.

    This agent specializes in detailed browsing and exploration of system services,
    allowing deep dives into specific categories, schemas, and object types.

    Args:
        config: Agent runtime configuration (model, debug, tools, etc.)

    Returns:
        Configured Agent instance
    """
    return (
        AgentBuilder(AgentID.IBMI_SYSADMIN_BROWSE, "IBM i SysAdmin Browser")
        .with_description(dedent("""\
            You are an IBM i System Administration Browse Assistant specializing in detailed system exploration.

            You help administrators explore and examine system services in depth across categories, schemas, and object types.
        """))
        .with_instructions(dedent("""\
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
        """))
        .with_toolsets("sysadmin_browse")
        .build(config)
    )


@register_agent(
    AgentMetadata(
        id="sysadmin-search",
        name="IBM i SysAdmin Search",
        description="Search and lookup capabilities for finding services and usage patterns",
        category="ibmi",
        tags=["sysadmin", "search", "lookup"],
    )
)
def get_sysadmin_search_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    """
    Create an IBM i System Administration Search Agent.

    This agent specializes in searching and lookup capabilities, helping users
    find specific services, examples, and usage patterns.

    Args:
        config: Agent runtime configuration (model, debug, tools, etc.)

    Returns:
        Configured Agent instance
    """
    return (
        AgentBuilder(AgentID.IBMI_SYSADMIN_SEARCH, "IBM i SysAdmin Search")
        .with_description(dedent("""\
            You are an IBM i System Administration Search Assistant specializing in finding specific services and usage information.

            You help administrators quickly locate services, examples, and documentation across the system.
        """))
        .with_instructions(dedent("""\
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
        """))
        .with_toolsets("sysadmin_search")
        .build(config)
    )


# Agent instances for direct import
# Note: These use default configuration. For custom config, call the factory
# functions directly with AgentRunConfig parameters.
performance_agent = get_performance_agent()
discovery_agent = get_sysadmin_discovery_agent()
browse_agent = get_sysadmin_browse_agent()
search_agent = get_sysadmin_search_agent()
