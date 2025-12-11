"""
Model Selection Utility

Provides a unified interface for selecting between different AI model providers
(OpenAI, Anthropic, WatsonX, Ollama) using a provider:model_id format.

Example usage:
    # Basic usage
    model = get_model("openai:gpt-4o")
    model = get_model("anthropic:claude-sonnet-4")
    model = get_model("watsonx:llama-3-3-70b-instruct")
    model = get_model("ollama:llama3.2")

    # Pass custom kwargs
    model = get_model("openai:gpt-4o-mini", temperature=0.7)

    # Pass pre-configured model instance
    from agno.models.openai import OpenAIChat
    custom_model = OpenAIChat(id="gpt-4o", temperature=0.5)
    agent = get_performance_agent(model=custom_model)
"""

from typing import Union

from agno.models.base import Model
from agno.models.openai import OpenAIChat
from agno.models.anthropic import Claude
from agno.models.ollama import Ollama


def get_model(model_spec: Union[str, Model], **kwargs) -> Model:
    """
    Get a model instance based on provider:model_id specification or direct model object.

    Args:
        model_spec: Either:
                   - String in format "provider:model_id" (e.g., "openai:gpt-4o")
                   - Pre-configured model instance
        **kwargs: Additional arguments to pass to the model constructor (ignored if model_spec is an object)

    Returns:
        Model instance

    Raises:
        ValueError: If provider is not recognized or format is invalid

    Examples:
        >>> # Using string specification
        >>> model = get_model("openai:gpt-4o")
        >>> model = get_model("anthropic:claude-sonnet-4")
        >>> model = get_model("watsonx:llama-3-3-70b-instruct")
        >>> model = get_model("ollama:llama3.2")

        >>> # With custom parameters
        >>> model = get_model("openai:gpt-4o-mini", temperature=0.7)

        >>> # Using pre-configured model
        >>> from agno.models.openai import OpenAIChat
        >>> custom_model = OpenAIChat(id="gpt-4o", temperature=0.5)
        >>> model = get_model(custom_model)
    """
    # If already a model object, return it directly
    if not isinstance(model_spec, str):
        return model_spec

    if ":" not in model_spec:
        raise ValueError(
            f"Invalid model specification: '{model_spec}'. "
            f"Expected format: 'provider:model_id' (e.g., 'openai:gpt-4o', 'anthropic:claude-sonnet-4', "
            f"'watsonx:llama-3-3-70b-instruct', 'ollama:llama3.2')"
        )

    provider, model_id = model_spec.split(":", 1)
    provider = provider.lower().strip()

    if provider == "openai":
        return OpenAIChat(id=model_id, **kwargs)
    elif provider == "anthropic":
        return Claude(id=model_id, **kwargs)
    elif provider == "ollama":
        return Ollama(id=model_id, **kwargs)
    else:
        supported_providers = ["openai", "anthropic", "watsonx", "ollama"]
        raise ValueError(
            f"Unsupported provider: '{provider}'. Supported providers: {', '.join(supported_providers)}"
        )


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
        raise ValueError(
            f"Invalid model specification: '{model_spec}'. Expected format: 'provider:model_id'"
        )

    provider, model_id = model_spec.split(":", 1)
    return provider.lower().strip(), model_id.strip()


# Common model specifications for convenience
COMMON_MODELS = {
    # OpenAI models
    "gpt-4o": "openai:gpt-4o",
    "gpt-4o-mini": "openai:gpt-4o-mini",
    "gpt-4-turbo": "openai:gpt-4-turbo",
    "gpt-3.5-turbo": "openai:gpt-3.5-turbo",
    # Anthropic models
    "claude-4.5": "anthropic:claude-sonnet-4-5-20250929",
    "claude-sonnet": "anthropic:claude-sonnet-4-5-20250929",
    "claude-opus": "anthropic:claude-opus-4-20250514",
    "claude-haiku": "anthropic:claude-3-5-haiku-20241022",
    # WatsonX models
    "llama-3.3": "watsonx:llama-3-3-70b-instruct",
    "llama-3.1": "watsonx:llama-3-1-70b-instruct",
    "granite-3": "watsonx:granite-3-8b-instruct",
    # Ollama models (common local models)
    "llama3.2": "ollama:llama3.2",
    "llama3.1": "ollama:llama3.1",
    "mistral": "ollama:mistral",
    "phi3": "ollama:phi3",
}


def get_model_by_alias(alias: str, **kwargs) -> Model:
    """
    Get a model instance by alias or full specification.

    Args:
        alias: Model alias (e.g., "gpt-4o", "claude-sonnet") or full spec (e.g., "openai:gpt-4o")
        **kwargs: Additional arguments to pass to the model constructor

    Returns:
        Model instance

    Examples:
        >>> model = get_model_by_alias("gpt-4o")  # Uses common alias
        >>> model = get_model_by_alias("claude-sonnet")  # Anthropic alias
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
