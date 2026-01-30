"""Agent ID definitions for IBM i specialized agents.

This module defines the official agent IDs used throughout the system,
ensuring consistency between configuration, agent creation, and runtime usage.
"""

from enum import Enum


class AgentID(str, Enum):
    """Official agent identifiers for IBM i specialized agents.

    Enum keys are uppercase snake case versions of the agent IDs.
    Enum values are the actual lowercase-with-hyphens agent IDs used as:
    - Agent IDs in agent creation (Agent(id=...))
    - Configuration keys in config.yaml under agents: section
    """

    IBMI_PERFORMANCE_MONITOR = "ibmi-performance-monitor"
    IBMI_SYSADMIN_DISCOVERY = "ibmi-sysadmin-discovery"
    IBMI_SYSADMIN_BROWSE = "ibmi-sysadmin-browse"
    IBMI_SYSADMIN_SEARCH = "ibmi-sysadmin-search"

    @classmethod
    def from_agent_id(cls, agent_id: str) -> "AgentID":
        """Get AgentID from an agent ID string.

        Args:
            agent_id: Agent ID (e.g., 'ibmi-performance-monitor')

        Returns:
            Corresponding AgentID enum member

        Raises:
            ValueError: If the agent_id doesn't match any agent
        """
        for member in cls:
            if member.value == agent_id:
                return member
        raise ValueError(f"Unknown agent ID: {agent_id}. Valid options: {cls.all_ids()}")

    @classmethod
    def all_ids(cls) -> list[str]:
        """Get all agent IDs.

        Returns:
            List of agent ID strings (lowercase with hyphens)
        """
        return [member.value for member in cls]

    def __str__(self) -> str:
        """String representation returns the agent ID value."""
        return self.value
