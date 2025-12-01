"""
Central Configuration System

This module provides a centralized configuration system for the application,
loading values from environment variables with validation and type safety.

Environment variables are loaded from .env file automatically.
"""

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

from db.url import get_db_url

# Load environment variables from .env file in the infra directory
_infra_dir = Path(__file__).parent
_env_file = _infra_dir / ".env"

# Load from infra/.env if it exists, otherwise try root .env
if _env_file.exists():
    load_dotenv(_env_file)
else:
    # Try to load from root directory
    load_dotenv()


@dataclass
class MCPConfig:
    """MCP Server configuration."""

    url: str = "http://127.0.0.1:3010/mcp"
    transport: str = "streamable-http"

    @classmethod
    def from_env(cls) -> "MCPConfig":
        """Load MCP configuration from environment variables."""
        return cls(
            url=os.getenv("MCP_URL", cls.url),
            transport=os.getenv("MCP_TRANSPORT", cls.transport),
        )


@dataclass
class WatsonxConfig:
    """
    IBM watsonx configuration.

    Maps to WatsonX model class parameters:
    - api_key: API key for authentication
    - project_id: Project ID (required if space_id not provided)
    - space_id: Space ID (alternative to project_id)
    - url: Base URL for watsonx API
    - verify: SSL certificate verification (default: True)
    """

    api_key: Optional[str] = None
    project_id: Optional[str] = None
    space_id: Optional[str] = None
    url: str = "https://us-south.ml.cloud.ibm.com"
    model_id: str = "meta-llama/llama-3-3-70b-instruct"
    verify: bool = True

    @classmethod
    def from_env(cls) -> "WatsonxConfig":
        """Load watsonx configuration from environment variables."""
        return cls(
            api_key=os.getenv("WATSONX_API_KEY"),
            project_id=os.getenv("WATSONX_PROJECT_ID"),
            space_id=os.getenv("WATSONX_SPACE_ID"),
            url=os.getenv("WATSONX_URL") or os.getenv("WATSONX_BASE_URL", cls.url),
            model_id=os.getenv("WATSONX_MODEL_ID", cls.model_id),
            verify=os.getenv("WATSONX_VERIFY", "true").lower() not in ("false", "0", "no"),
        )

    def to_model_kwargs(self) -> dict:
        """
        Convert config to kwargs for watsonx model initialization.

        Returns kwargs compatible with WatsonX class constructor:
        - api_key: str
        - project_id: str (or space_id)
        - url: str
        - verify: bool
        """
        kwargs = {}
        if self.api_key:
            kwargs["api_key"] = self.api_key
        if self.project_id:
            kwargs["project_id"] = self.project_id
        elif self.space_id:
            kwargs["space_id"] = self.space_id
        if self.url:
            kwargs["url"] = self.url
        kwargs["verify"] = self.verify
        return kwargs

    @property
    def is_configured(self) -> bool:
        """Check if watsonx is properly configured."""
        return bool(self.api_key and (self.project_id or self.space_id))


@dataclass
class OpenAIConfig:
    """OpenAI configuration."""

    api_key: Optional[str] = None
    organization: Optional[str] = None
    base_url: Optional[str] = None

    @classmethod
    def from_env(cls) -> "OpenAIConfig":
        """Load OpenAI configuration from environment variables."""
        return cls(
            api_key=os.getenv("OPENAI_API_KEY"),
            organization=os.getenv("OPENAI_ORGANIZATION"),
            base_url=os.getenv("OPENAI_BASE_URL"),
        )

    def to_model_kwargs(self) -> dict:
        """Convert config to kwargs for OpenAI model initialization."""
        kwargs = {}
        if self.api_key:
            kwargs["api_key"] = self.api_key
        if self.organization:
            kwargs["organization"] = self.organization
        if self.base_url:
            kwargs["base_url"] = self.base_url
        return kwargs

    @property
    def is_configured(self) -> bool:
        """Check if OpenAI is properly configured."""
        return bool(self.api_key)


@dataclass
class DatabaseConfig:
    """Database configuration."""

    url: str = "postgresql://postgres:mysecretpassword@localhost:5432/agno"

    @classmethod
    def from_env(cls) -> "DatabaseConfig":
        """Load database configuration from environment variables using get_db_url helper."""
        # Use the centralized get_db_url helper from db.url module
        # This handles DB_DRIVER, DB_USER, DB_PASS, DB_HOST, DB_PORT, DB_DATABASE
        db_url = get_db_url()
        return cls(url=db_url)

    @property
    def connection_url(self) -> str:
        """Get the database connection URL."""
        return self.url


@dataclass
class AppConfig:
    """Main application configuration."""

    # Sub-configurations
    mcp: MCPConfig
    watsonx: WatsonxConfig
    openai: OpenAIConfig
    database: DatabaseConfig

    # Application settings
    debug: bool = False
    log_level: str = "INFO"

    @classmethod
    def from_env(cls) -> "AppConfig":
        """Load complete application configuration from environment variables."""
        return cls(
            mcp=MCPConfig.from_env(),
            watsonx=WatsonxConfig.from_env(),
            openai=OpenAIConfig.from_env(),
            database=DatabaseConfig.from_env(),
            debug=os.getenv("DEBUG", "false").lower() in ("true", "1", "yes"),
            log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        )


# Global configuration instance
config = AppConfig.from_env()


# Convenience exports for backward compatibility
ibmi_mcp_server = {"MCP_URL": config.mcp.url, "MCP_TRANSPORT": config.mcp.transport}

watsonx_config = {
    "WATSONX_API_KEY": config.watsonx.api_key or "",
    "WATSONX_BASE_URL": config.watsonx.url,
    "WATSONX_PROJECT_ID": config.watsonx.project_id or "",
    "WATSONX_MODEL_ID": config.watsonx.model_id,
}
