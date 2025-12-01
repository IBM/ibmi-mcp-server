"""Configuration manager for loading and parsing agent configuration files."""

import os
from pathlib import Path
from typing import Dict, List, Optional, Union

import yaml
from agno.os.config import AgentOSConfig
from pydantic import BaseModel, Field

from agents.agent_ids import AgentID


class AgentModelConfig(BaseModel):
    """Configuration for an individual agent's model settings."""

    model: Optional[str] = Field(
        None,
        description="Model to use for this agent in format 'provider:model_id' (e.g., 'openai:gpt-4o', 'watsonx:llama-3-3-70b-instruct')",
    )
    enable_reasoning: Optional[bool] = Field(True, description="Enable reasoning tools for structured analysis")
    debug_mode: Optional[bool] = Field(False, description="Enable debug mode for detailed logging")


class AgentsConfig(BaseModel):
    """Configuration for all IBM i agents.

    The agents field is a dictionary where keys are agent IDs (e.g., 'ibmi-performance-monitor')
    and values are AgentModelConfig objects.
    """

    default_model: Optional[str] = Field(
        "openai:gpt-4o", description="Default model to use for agents that don't specify one"
    )

    class Config:
        extra = "allow"  # Allow extra fields for agent configurations


class ExtendedAgentOSConfig(AgentOSConfig):
    """Extended AgentOS configuration with IBM i agent-specific settings."""

    agents: Optional[AgentsConfig] = Field(
        default_factory=AgentsConfig, description="Configuration for IBM i specialized agents"
    )


class AgentConfigManager:
    """Manager for loading and accessing agent configuration.

    Configuration path resolution (in order of precedence):
    1. Explicitly provided config_path parameter
    2. AGENT_CONFIG_PATH environment variable
    3. Default: infra/config.yaml (relative to current working directory)
    """

    DEFAULT_CONFIG_PATH = "infra/config.yaml"
    ENV_VAR_NAME = "AGENT_CONFIG_PATH"

    def __init__(self, config_path: Optional[str] = None):
        """Initialize the config manager with a path to the config file.

        Args:
            config_path: Optional path to the YAML configuration file.
                        If not provided, uses AGENT_CONFIG_PATH env var or default path.

        Examples:
            >>> # Use default path (infra/config.yaml)
            >>> config_mgr = AgentConfigManager()

            >>> # Use explicit path
            >>> config_mgr = AgentConfigManager("custom/config.yaml")

            >>> # Use environment variable
            >>> os.environ['AGENT_CONFIG_PATH'] = '/etc/agent/config.yaml'
            >>> config_mgr = AgentConfigManager()
        """
        self.config_path = self._resolve_config_path(config_path)
        self.agent_config = self.load_config()

    def _resolve_config_path(self, config_path: Optional[str]) -> Path:
        """Resolve the configuration file path.

        Args:
            config_path: Explicitly provided path (highest priority)

        Returns:
            Resolved Path object

        Priority order:
        1. Explicit config_path parameter
        2. AGENT_CONFIG_PATH environment variable
        3. Default path (infra/config.yaml)
        """
        # Priority 1: Explicit path provided
        if config_path:
            self._config_source = "explicit"
            return Path(config_path)

        # Priority 2: Environment variable
        env_path = os.environ.get(self.ENV_VAR_NAME)
        if env_path:
            self._config_source = "environment"
            return Path(env_path)

        # Priority 3: Default path
        self._config_source = "default"
        return Path(self.DEFAULT_CONFIG_PATH)

    def get_config_source(self) -> str:
        """Get a description of where the configuration was loaded from.

        Returns:
            String describing the config source (e.g., "default", "environment", "explicit")
        """
        source_descriptions = {
            "explicit": f"explicit path: {self.config_path}",
            "environment": f"environment variable {self.ENV_VAR_NAME}: {self.config_path}",
            "default": f"default: {self.config_path}",
        }
        return source_descriptions.get(self._config_source, f"unknown: {self.config_path}")

    def read_config_file(self) -> dict:
        """Read and parse the YAML configuration file.

        Returns:
            Dictionary containing the parsed YAML content

        Raises:
            FileNotFoundError: If the config file doesn't exist
            yaml.YAMLError: If the YAML is malformed
        """
        if not self.config_path.exists():
            raise FileNotFoundError(f"Config file not found: {self.config_path}")

        with open(self.config_path, "r") as file:
            return yaml.safe_load(file)

    def load_config(self) -> ExtendedAgentOSConfig:
        """Load the configuration and create an ExtendedAgentOSConfig object.

        Returns:
            ExtendedAgentOSConfig object with parsed and validated configuration

        Raises:
            pydantic.ValidationError: If the config doesn't match the schema
        """
        config_data = self.read_config_file()

        # Use Pydantic's model_validate to parse and validate the config
        return ExtendedAgentOSConfig.model_validate(config_data)

    def get_available_models(self) -> List[str]:
        """Get list of available chat models.

        Returns:
            List of available model identifiers, or empty list if not configured
        """
        return self.agent_config.available_models or []

    def get_quick_prompts(self, agent_type: str = None) -> Dict[str, List[str]] | List[str]:
        """Get quick prompts for a specific agent or all agents.

        Args:
            agent_type: Optional agent type to filter prompts (e.g., 'web-search-agent')

        Returns:
            If agent_type is specified, returns list of prompts for that agent.
            Otherwise, returns dict of all agent types and their prompts.
        """
        if not self.agent_config.chat or not self.agent_config.chat.quick_prompts:
            return [] if agent_type else {}

        if agent_type:
            return self.agent_config.chat.quick_prompts.get(agent_type, [])
        return self.agent_config.chat.quick_prompts

    def reload_config(self) -> None:
        """Reload the configuration from disk.

        Useful for picking up configuration changes without restarting the application.
        """
        self.agent_config = self.load_config()

    def get_agent_model(self, agent_id: Union[str, AgentID]) -> str:
        """Get the model configuration for a specific agent.

        Args:
            agent_id: Agent ID as string or AgentID enum (e.g., 'ibmi-performance-monitor' or AgentID.IBMI_PERFORMANCE_MONITOR)

        Returns:
            Model string in format 'provider:model_id', using default_model if not specified

        Raises:
            ValueError: If agent_id is not recognized
        """
        # Convert to string if AgentID enum
        if isinstance(agent_id, AgentID):
            agent_id = agent_id.value

        # Validate agent_id
        if agent_id not in AgentID.all_ids():
            raise ValueError(f"Unknown agent ID: {agent_id}. Valid options: {AgentID.all_ids()}")

        if not self.agent_config.agents:
            return "openai:gpt-4o"  # Fallback default

        # Get the agent config from the extra fields
        agent_config_dict = self.agent_config.agents.model_extra or {}
        agent_data = agent_config_dict.get(agent_id)

        if agent_data and isinstance(agent_data, dict):
            model = agent_data.get("model")
            if model:
                return model

        return self.agent_config.agents.default_model or "openai:gpt-4o"

    def get_agent_config(self, agent_id: Union[str, AgentID]) -> AgentModelConfig:
        """Get the full configuration for a specific agent.

        Args:
            agent_id: Agent ID as string or AgentID enum (e.g., 'ibmi-performance-monitor' or AgentID.IBMI_PERFORMANCE_MONITOR)

        Returns:
            AgentModelConfig with all settings for the agent

        Raises:
            ValueError: If agent_id is not recognized
        """
        # Convert to string if AgentID enum
        if isinstance(agent_id, AgentID):
            agent_id = agent_id.value

        # Validate agent_id
        if agent_id not in AgentID.all_ids():
            raise ValueError(f"Unknown agent ID: {agent_id}. Valid options: {AgentID.all_ids()}")

        if not self.agent_config.agents:
            return AgentModelConfig()

        # Get the agent config from the extra fields
        agent_config_dict = self.agent_config.agents.model_extra or {}
        agent_data = agent_config_dict.get(agent_id)

        if not agent_data:
            return AgentModelConfig()

        # Parse the agent data into AgentModelConfig
        agent_config = AgentModelConfig.model_validate(agent_data)

        # Fill in defaults from default_model if not specified
        if not agent_config.model and self.agent_config.agents.default_model:
            agent_config.model = self.agent_config.agents.default_model

        return agent_config

    def get_all_agent_configs(self) -> Dict[str, AgentModelConfig]:
        """Get configurations for all agents.

        Returns:
            Dictionary mapping agent IDs to their configurations
        """
        return {agent_id: self.get_agent_config(agent_id) for agent_id in AgentID.all_ids()}
