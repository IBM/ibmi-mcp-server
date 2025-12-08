"""
Agent Runtime Configuration

This module provides a unified configuration object for IBM i agents, replacing
the previous 6-parameter pattern with a single, type-safe dataclass.

Usage:
    from agents.config import AgentRunConfig

    # Basic usage
    config = AgentRunConfig(model="openai:gpt-4o", debug_mode=True)

    # With config file
    from infra.config_manager import AgentConfigManager
    config = AgentRunConfig(
        model="watsonx:llama-3-3-70b-instruct",
        config_manager=AgentConfigManager("infra/config.yaml")
    )

    # Agent factory
    agent = get_performance_agent(config=config)
"""

from dataclasses import dataclass
from typing import Union, Optional

from agno.models.base import Model
from infra.config_manager import AgentConfigManager


@dataclass
class AgentRunConfig:
    """
    Unified runtime configuration for IBM i agents.

    All agent factory functions accept this single configuration object instead
    of multiple parameters. This provides type safety, clear documentation, and
    makes it easy to add new configuration options without breaking existing code.

    Storage configuration (PostgreSQL vs SQLite) is handled at the infrastructure
    level via environment variables (USE_SQLITE, SQLITE_DB_PATH), not in this config.

    Attributes:
        model: Model specification string ("provider:model_id") or Model instance
        debug_mode: Enable debug logging and verbose output
        enable_reasoning: Include ReasoningTools for structured analysis
        mcp_url: Override default MCP server URL
        transport: Override default MCP transport type
        debug_filtering: Enable debug output for tool filtering
        config_manager: Optional config manager for YAML-based configuration
    """

    # Core parameters (most commonly used)
    model: Union[str, Model] = "openai:gpt-4o"
    debug_mode: bool = False

    # Advanced parameters (optional, with sensible defaults)
    enable_reasoning: bool = True
    mcp_url: Optional[str] = None
    transport: Optional[str] = None
    debug_filtering: bool = False

    # Configuration management
    config_manager: Optional[AgentConfigManager] = None

    def with_config_overrides(self, agent_id: str) -> "AgentRunConfig":
        """
        Apply configuration file overrides for a specific agent.

        If a config_manager is provided, this method retrieves agent-specific
        configuration from the YAML file and creates a new AgentRunConfig with
        those overrides applied.

        Args:
            agent_id: Agent identifier (e.g., "ibmi-performance-monitor")

        Returns:
            New AgentRunConfig with config file overrides applied, or self if
            no config_manager is provided

        Example:
            >>> config = AgentRunConfig(config_manager=AgentConfigManager("config.yaml"))
            >>> effective = config.with_config_overrides("ibmi-performance-monitor")
            >>> # effective.model may now be different if specified in config.yaml
        """
        if not self.config_manager:
            return self

        agent_config = self.config_manager.get_agent_config(agent_id)

        # Create new config with overrides from file
        return AgentRunConfig(
            # Apply config file values if present, otherwise keep runtime values
            model=agent_config.model or self.model,
            debug_mode=(
                agent_config.debug_mode
                if agent_config.debug_mode is not None
                else self.debug_mode
            ),
            enable_reasoning=(
                agent_config.enable_reasoning
                if agent_config.enable_reasoning is not None
                else self.enable_reasoning
            ),
            # Advanced params not overrideable from config file
            mcp_url=self.mcp_url,
            transport=self.transport,
            debug_filtering=self.debug_filtering,
            config_manager=self.config_manager,
        )
