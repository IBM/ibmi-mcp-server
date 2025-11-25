"""
Model Selection Utility

Provides a unified interface for selecting between different AI model providers
(OpenAI, watsonx, etc.) using a provider:model_id format.

Example usage:
    # Basic usage with env vars
    model = get_model("openai:gpt-4o")
    model = get_model("watsonx:llama-3-3-70b-instruct")

    # Pass custom kwargs
    model = get_model("openai:gpt-4o-mini", temperature=0.7)

    # Pass pre-configured model instance
    from agents.utils.watsonx import MyWatsonx
    custom_model = MyWatsonx(id="llama-3-3-70b-instruct", project_id="custom")
    agent = get_performance_agent(model=custom_model)
"""

from typing import Union

from agno.models.base import Model
from agno.models.openai import OpenAIChat
from agno.models.anthropic import Claude
from agents.utils.watsonx import MyWatsonx
from infra.config_models import config
from dotenv import load_dotenv

load_dotenv()


def get_model(model_spec: str | object, **kwargs) -> Union[Model]:
    """
    Get a model instance based on provider:model_id specification or direct model object.

    Args:
        model_spec: Either:
                   - String in format "provider:model_id" (e.g., "openai:gpt-4o")
                   - Pre-configured model instance (OpenAIChat or MyWatsonx)
        **kwargs: Additional arguments to pass to the model constructor (ignored if model_spec is an object)

    Returns:
        Model instance (OpenAIChat or MyWatsonx)

    Raises:
        ValueError: If provider is not recognized or format is invalid

    Examples:
        >>> # Using string specification
        >>> model = get_model("openai:gpt-4o")
        >>> model = get_model("watsonx:llama-3-3-70b-instruct")
        >>> model = get_model("openai:gpt-4o-mini", temperature=0.7)

        >>> # Using pre-configured model
        >>> custom_model = MyWatsonx(id="llama-3-3-70b-instruct", project_id="custom")
        >>> model = get_model(custom_model)

        >>> # watsonx with environment variables (auto-configured)
        >>> # Set WATSONX_API_KEY and WATSONX_PROJECT_ID in environment
        >>> model = get_model("watsonx:llama-3-3-70b-instruct")
    """
    # If already a model object, return it directly
    if not isinstance(model_spec, str):
        return model_spec

    if ":" not in model_spec:
        raise ValueError(
            f"Invalid model specification: '{model_spec}'. "
            f"Expected format: 'provider:model_id' (e.g., 'openai:gpt-4o' or 'watsonx:llama-3-3-70b-instruct')"
        )

    provider, model_id = model_spec.split(":", 1)
    provider = provider.lower().strip()

    if provider == "openai":
        # Merge central config with kwargs (kwargs take precedence)
        openai_kwargs = config.openai.to_model_kwargs()
        openai_kwargs.update(kwargs)
        return OpenAIChat(id=model_id, **openai_kwargs)
    elif provider == "watsonx":
        # Merge central config with kwargs (kwargs take precedence)
        watsonx_kwargs = config.watsonx.to_model_kwargs()
        watsonx_kwargs.update(kwargs)
        return MyWatsonx(id=model_id, **watsonx_kwargs)
    elif provider == "anthropic":
        return Claude(id=model_id, **kwargs)
    else:
        supported_providers = ["openai", "watsonx", "anthropic"]
        raise ValueError(f"Unsupported provider: '{provider}'. Supported providers: {', '.join(supported_providers)}")


def parse_model_spec(model_spec: str) -> tuple[str, str]:
    """
    Parse a model specification into provider and model_id components.

    Args:
        model_spec: Model specification in format "provider:model_id"

    Returns:
        Tuple of (provider, model_id)

    Raises:
        ValueError: If format is invalid

    Examples:
        >>> provider, model_id = parse_model_spec("openai:gpt-4o")
        >>> print(provider)  # "openai"
        >>> print(model_id)  # "gpt-4o"
    """
    if ":" not in model_spec:
        raise ValueError(f"Invalid model specification: '{model_spec}'. Expected format: 'provider:model_id'")

    provider, model_id = model_spec.split(":", 1)
    return provider.lower().strip(), model_id.strip()


# Common model specifications for convenience
COMMON_MODELS = {
    # OpenAI models
    "gpt-4o": "openai:gpt-4o",
    "gpt-4o-mini": "openai:gpt-4o-mini",
    "gpt-4-turbo": "openai:gpt-4-turbo",
    "gpt-3.5-turbo": "openai:gpt-3.5-turbo",
    # watsonx models
    "llama-3.3": "watsonx:llama-3-3-70b-instruct",
    "llama-3.1": "watsonx:llama-3-1-70b-instruct",
    "granite-3": "watsonx:granite-3-8b-instruct",
    "claude4.5": "anthropic:claude-sonnet-4-5",
}


def get_model_by_alias(alias: str, **kwargs) -> Union[Model]:
    """
    Get a model instance by alias or full specification.

    Args:
        alias: Model alias (e.g., "gpt-4o", "llama-3.3") or full spec (e.g., "openai:gpt-4o")
        **kwargs: Additional arguments to pass to the model constructor

    Returns:
        Model instance

    Examples:
        >>> model = get_model_by_alias("gpt-4o")  # Uses common alias
        >>> model = get_model_by_alias("openai:gpt-4o")  # Uses full spec
    """
    # If it's already in provider:model format, use it directly
    if ":" in alias:
        return get_model(alias, **kwargs)

    # Otherwise, check if it's a known alias
    if alias in COMMON_MODELS:
        return get_model(COMMON_MODELS[alias], **kwargs)

    # If not found, raise error with helpful message
    raise ValueError(
        f"Unknown model alias: '{alias}'. "
        f"Available aliases: {', '.join(COMMON_MODELS.keys())} "
        f"or use full specification format 'provider:model_id'"
    )
