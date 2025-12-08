"""
Agent Registry for CLI Auto-Discovery

This module provides a type-safe, Pydantic-based registry for agents, making it easy to:
- Register new agents with validated metadata
- Automatically discover agents for CLI listing
- Create agent instances with consistent configuration

Usage in agent files:
    from agents.registry import register_agent, AgentMetadata
    from agno.agent import Agent

    @register_agent(
        AgentMetadata(
            id="my-agent",
            name="My Agent",
            description="Does something useful",
            category="ibmi"
        )
    )
    def get_my_agent(model_id: str = "openai:gpt-4o", debug_mode: bool = False) -> Agent:
        return create_agent(...)

Usage in CLI:
    from agents.registry import get_all_agents, AgentRegistration

    agents: dict[str, AgentRegistration] = get_all_agents()
"""

from dataclasses import dataclass
from typing import Callable, Protocol, TYPE_CHECKING
from functools import wraps

from pydantic import BaseModel, Field
from agno.agent import Agent

# Import AgentRunConfig only for type checking to avoid circular import
if TYPE_CHECKING:
    from agents.config import AgentRunConfig


class AgentMetadata(BaseModel):
    """
    Metadata describing an agent's identity and capabilities.

    Attributes:
        id: Unique agent identifier (kebab-case, used in CLI --agent flag)
        name: Human-readable agent name
        description: Brief description of agent capabilities (1-2 sentences)
        category: Agent category for grouping (default: "ibmi")
        tags: Optional list of tags for filtering/searching
    """

    id: str = Field(..., description="Unique agent identifier (kebab-case)", pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
    name: str = Field(..., description="Human-readable agent name", min_length=1)
    description: str = Field(..., description="Brief description of agent capabilities", min_length=1)
    category: str = Field(default="ibmi", description="Agent category for grouping")
    tags: list[str] = Field(default_factory=list, description="Optional tags for filtering")

    model_config = {"frozen": True}  # Make immutable


class AgentFactory(Protocol):
    """
    Protocol defining the signature for agent factory functions.

    All agent factory functions must accept a single AgentRunConfig parameter
    (with default value) and return an Agent instance.
    """

    def __call__(self, config: "AgentRunConfig" = None) -> Agent:
        """
        Create an agent instance.

        Args:
            config: Agent runtime configuration (model, debug, tools, etc.)

        Returns:
            Configured Agent instance
        """
        ...


@dataclass(frozen=True)
class AgentRegistration:
    """
    Complete registration record for an agent.

    Combines metadata with the factory function that creates agent instances.

    Attributes:
        metadata: Agent metadata (identity and capabilities)
        factory: Factory function that creates agent instances
    """

    metadata: AgentMetadata
    factory: AgentFactory


# Global registry for all agents
# Using dict for O(1) lookup by agent ID
_AGENT_REGISTRY: dict[str, AgentRegistration] = {}


def register_agent(metadata: AgentMetadata) -> Callable[[AgentFactory], AgentFactory]:
    """
    Decorator to register an agent factory function with type-safe metadata.

    Args:
        metadata: Validated agent metadata (Pydantic model)

    Returns:
        Decorator function that registers the agent factory

    Raises:
        ValueError: If an agent with the same ID is already registered

    Example:
        @register_agent(
            AgentMetadata(
                id="performance",
                name="IBM i Performance Monitor",
                description="System performance monitoring and analysis",
                category="ibmi",
                tags=["performance", "monitoring"]
            )
        )
        def get_performance_agent(
            model_id: str = "openai:gpt-4o",
            debug_mode: bool = False
        ) -> Agent:
            return create_ibmi_agent(...)
    """

    def decorator(factory_func: AgentFactory) -> AgentFactory:
        # Check for duplicate registration
        if metadata.id in _AGENT_REGISTRY:
            raise ValueError(
                f"Agent ID '{metadata.id}' is already registered. "
                f"Existing: {_AGENT_REGISTRY[metadata.id].metadata.name}"
            )

        # Create registration record
        registration = AgentRegistration(metadata=metadata, factory=factory_func)

        # Register the agent
        _AGENT_REGISTRY[metadata.id] = registration

        # Return the original function unchanged (preserves type hints)
        @wraps(factory_func)
        def wrapper(*args, **kwargs) -> Agent:
            return factory_func(*args, **kwargs)

        return wrapper

    return decorator


def get_all_agents() -> dict[str, AgentRegistration]:
    """
    Get all registered agents.

    Returns:
        Dictionary mapping agent IDs to their registration records (metadata + factory)
    """
    return _AGENT_REGISTRY.copy()


def get_agent_by_id(agent_id: str) -> AgentRegistration | None:
    """
    Get a specific agent registration by ID.

    Args:
        agent_id: The agent identifier

    Returns:
        AgentRegistration if found, None otherwise
    """
    return _AGENT_REGISTRY.get(agent_id)


def list_agent_ids() -> list[str]:
    """
    Get list of all registered agent IDs.

    Returns:
        Sorted list of agent ID strings
    """
    return sorted(_AGENT_REGISTRY.keys())


def get_agents_by_category(category: str) -> dict[str, AgentRegistration]:
    """
    Get all agents in a specific category.

    Args:
        category: Category name to filter by

    Returns:
        Dictionary of agents in the specified category
    """
    return {agent_id: reg for agent_id, reg in _AGENT_REGISTRY.items() if reg.metadata.category == category}


def get_agents_by_tag(tag: str) -> dict[str, AgentRegistration]:
    """
    Get all agents with a specific tag.

    Args:
        tag: Tag to filter by

    Returns:
        Dictionary of agents with the specified tag
    """
    return {agent_id: reg for agent_id, reg in _AGENT_REGISTRY.items() if tag in reg.metadata.tags}


def clear_registry() -> None:
    """
    Clear all registered agents.

    Useful for testing or hot-reloading scenarios.
    """
    _AGENT_REGISTRY.clear()
