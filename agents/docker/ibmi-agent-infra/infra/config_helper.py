"""Helper functions for applying agent configuration from config.yaml.

This module provides utilities to apply configuration settings to agent
factory functions, avoiding code duplication.
"""

from typing import Optional, Tuple, Union

from agno.models.base import Model

from agents.agent_ids import AgentID
from infra.config_manager import AgentConfigManager


def apply_agent_config(
    agent_id: AgentID,
    config_manager: Optional[AgentConfigManager],
    model: Union[str, Model],
    debug_mode: bool,
    enable_reasoning: bool,
) -> Tuple[Union[str, Model], bool, bool]:
    """Apply configuration from config manager to agent parameters.

    This helper function extracts configuration for a specific agent from the
    config manager and applies it to the provided parameters, using the config
    values when available and falling back to the provided defaults.

    Args:
        agent_id: The AgentID enum member for the agent being configured
        config_manager: Optional AgentConfigManager instance. If None, returns unchanged parameters
        model: Current model setting (default or user-provided)
        debug_mode: Current debug_mode setting
        enable_reasoning: Current enable_reasoning setting

    Returns:
        Tuple of (model, debug_mode, enable_reasoning) with config applied

    Example:
        >>> from agents.agent_ids import AgentID
        >>> from infra.config_manager import AgentConfigManager
        >>>
        >>> # Using default config path (infra/config.yaml)
        >>> config_mgr = AgentConfigManager()
        >>> model, debug, reasoning = apply_agent_config(
        ...     agent_id=AgentID.IBMI_PERFORMANCE_MONITOR,
        ...     config_manager=config_mgr,
        ...     model="openai:gpt-4o",
        ...     debug_mode=False,
        ...     enable_reasoning=True
        ... )
    """
    if not config_manager:
        return model, debug_mode, enable_reasoning

    # Get agent configuration from config manager
    agent_config = config_manager.get_agent_config(agent_id)

    # Apply configuration values, preferring config over defaults
    configured_model = agent_config.model or model
    configured_debug = agent_config.debug_mode if agent_config.debug_mode is not None else debug_mode
    configured_reasoning = (
        agent_config.enable_reasoning if agent_config.enable_reasoning is not None else enable_reasoning
    )

    return configured_model, configured_debug, configured_reasoning
