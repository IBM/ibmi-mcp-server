"""
IBM i Agent Builder

Provides a simplified builder pattern for creating IBM i agents with minimal boilerplate.
Directly constructs Agno Agent() with **kwargs for future compatibility.

Usage:
    from agents.builder import AgentBuilder
    from agents.config import AgentRunConfig
    from agents.agent_ids import AgentID

    def get_my_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
        return (
            AgentBuilder(AgentID.MY_AGENT, "My Agent")
            .with_description("Agent description...")
            .with_instructions("Detailed instructions...")
            .with_toolsets("performance", "sysadmin")
            .build(config)
        )
"""

from typing import List, Any, Dict

from agno.agent import Agent
from agno.tools.reasoning import ReasoningTools

from agents.agent_ids import AgentID
from agents.config import AgentRunConfig
from agents.utils import FilteredMCPTools, get_model
from db.factory import get_database
from infra.config_models import config as env_config


# Default Agent() kwargs for all IBM i agents
# These can be overridden per-agent via with_agent_kwargs()
# Update this dict when Agno adds new Agent() parameters
DEFAULT_AGENT_KWARGS = {
    "markdown": True,
    "add_datetime_to_context": True,
    "search_session_history": True,
    "num_history_sessions": 2,
    "add_history_to_context": True,
    "num_history_runs": 3,
    "read_chat_history": True,
    "read_tool_call_history": True,
    "retries": 3,
    "enable_agentic_memory": True,
}


class AgentBuilder:
    """
    Builder pattern for creating IBM i agents with minimal boilerplate.

    This builder:
    - Directly constructs Agno Agent() with **kwargs for future compatibility
    - Handles all common setup (tools, config, reasoning)
    - Allows per-agent customization via fluent API

    All IBM i agents use FilteredMCPTools for MCP server integration.
    Additional tools (like custom Agno tools) can be added via with_additional_tools().

    Example:
        >>> builder = AgentBuilder(AgentID.IBMI_PERFORMANCE_MONITOR, "Performance Monitor")
        >>> agent = (
        ...     builder
        ...     .with_description("Performance monitoring agent")
        ...     .with_instructions("Monitor system performance...")
        ...     .with_toolsets("performance")
        ...     .build(config)
        ... )
    """

    def __init__(self, agent_id: AgentID, name: str):
        """
        Initialize builder with required agent metadata.

        Args:
            agent_id: Unique agent identifier from AgentID enum
            name: Human-readable agent name
        """
        self.agent_id = agent_id
        self.name = name
        self.description = ""
        self.instructions = ""
        self.toolsets: List[str] = []
        self.additional_tools: List[Any] = []
        self.agent_kwargs: Dict[str, Any] = DEFAULT_AGENT_KWARGS.copy()

    def with_description(self, description: str) -> "AgentBuilder":
        """
        Set agent description (used in system prompt).

        Args:
            description: Brief agent description, typically 1-3 paragraphs

        Returns:
            self for method chaining
        """
        self.description = description
        return self

    def with_instructions(self, instructions: str) -> "AgentBuilder":
        """
        Set agent instructions (detailed operational guidance).

        Args:
            instructions: Detailed instructions for the agent's behavior

        Returns:
            self for method chaining
        """
        self.instructions = instructions
        return self

    def with_toolsets(self, *toolsets: str) -> "AgentBuilder":
        """
        Add MCP toolset filters for tool discovery.

        Creates FilteredMCPTools with annotation_filters={"toolsets": [...]}.
        Common toolsets: "performance", "sysadmin_discovery", "sysadmin_browse",
        "sysadmin_search".

        Args:
            *toolsets: One or more toolset names to filter by

        Returns:
            self for method chaining

        Example:
            >>> builder.with_toolsets("performance", "sysadmin_browse")
        """
        self.toolsets = list(toolsets)
        return self

    def with_additional_tools(self, *tools: Any) -> "AgentBuilder":
        """
        Add custom tools beyond FilteredMCPTools.

        Use this for specialized Agno tools that aren't part of the MCP server.
        These tools are added in addition to the MCP tools and ReasoningTools.

        Args:
            *tools: One or more tool instances

        Returns:
            self for method chaining

        Example:
            >>> from custom_tools import DatabaseQueryTool
            >>> builder.with_additional_tools(DatabaseQueryTool())
        """
        self.additional_tools = list(tools)
        return self

    def with_agent_kwargs(self, **kwargs) -> "AgentBuilder":
        """
        Override default Agent() parameters for advanced use cases.

        This updates the agent_kwargs dict that gets passed to Agent() as **kwargs.
        Use this to customize Agno Agent behavior beyond the defaults.

        Args:
            **kwargs: Any valid Agent() parameters

        Returns:
            self for method chaining

        Example:
            >>> builder.with_agent_kwargs(
            ...     num_history_runs=10,  # More history
            ...     retries=5,            # More retries
            ...     markdown=False        # Plain text output
            ... )
        """
        self.agent_kwargs.update(kwargs)
        return self

    def build(self, config: AgentRunConfig) -> Agent:
        """
        Build the agent with the given runtime configuration.

        This method:
        1. Applies config file overrides if config_manager is present
        2. Builds tools list (FilteredMCPTools + additional + reasoning)
        3. Creates Agent() instance with all parameters

        Args:
            config: Runtime configuration for the agent

        Returns:
            Fully configured Agent instance

        Raises:
            Any exceptions from Agent() constructor or tool initialization
        """
        # Apply config overrides from config.yaml if provided
        effective_config = config.with_config_overrides(str(self.agent_id))

        # Build tools list
        tools_list = []

        # Add filtered MCP tools (all IBM i agents use this)
        if self.toolsets:
            mcp_tools = FilteredMCPTools(
                url=effective_config.mcp_url or env_config.mcp.url,
                transport=effective_config.transport or env_config.mcp.transport,
                annotation_filters={"toolsets": self.toolsets},
                debug_filtering=effective_config.debug_filtering,
            )
            tools_list.append(mcp_tools)

        # Add any additional custom tools
        tools_list.extend(self.additional_tools)

        # Add reasoning tools if enabled
        if effective_config.enable_reasoning:
            tools_list.append(ReasoningTools(add_instructions=True))

        # Directly create Agno Agent() with all parameters
        # This avoids create_ibmi_agent() and makes Agno version changes easier
        return Agent(
            id=self.agent_id,
            name=self.name,
            model=get_model(effective_config.model),
            description=self.description,
            instructions=self.instructions,
            tools=tools_list,
            debug_mode=effective_config.debug_mode,
            db=get_database(),  # Handles PostgreSQL vs SQLite based on env vars
            **self.agent_kwargs,  # Pass through all default + custom Agent() kwargs
        )
