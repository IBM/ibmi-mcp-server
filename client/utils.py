import argparse
from agno.models.ollama import Ollama
from agno.models.openai import OpenAIChat
from agno.models.base import Model
from agno.models.ibm import WatsonX
import os
from dotenv import load_dotenv, find_dotenv, dotenv_values


def get_model(model_id: str = None) -> Model:
    # Use find_dotenv() to automatically locate the nearest .env file
    dotenv_path = find_dotenv()
    env = {}
    
    if dotenv_path:
        load_dotenv(dotenv_path)
        env.update(dotenv_values(dotenv_path))
    
    # Also load from system environment as fallback
    env.update(os.environ)
    
    if model_id is None:
        return Ollama(id="qwen2.5:latest")  # Default model
    
    try:
        provider, model = model_id.split(":", 1)
    except ValueError:
        # Handle case where model_id doesn't contain ":"
        return Ollama(id="qwen2.5:latest")  # Default to Ollama
    
    match provider.lower():
        case "ollama":
            return Ollama(id=model)
        case "openai":
            if env.get("OPENAI_API_KEY") is None:
                raise ValueError("OPENAI_API_KEY environment variable is required for OpenAI models")
            return OpenAIChat(id=model, api_key=env.get("OPENAI_API_KEY"))
        case "anthropic":
            if env.get("ANTHROPIC_API_KEY") is None:
                raise ValueError("ANTHROPIC_API_KEY environment variable is required for Anthropic models")
            # Need to import Anthropic model
            from agno.models.anthropic import Anthropic
            return Anthropic(id=model, api_key=env.get("ANTHROPIC_API_KEY"))
        case "watsonx":
            if any(env.get(key) is None for key in ["IBM_WATSONX_API_KEY", "IBM_WATSONX_PROJECT_ID", "IBM_WATSONX_BASE_URL"]):
                raise ValueError("IBM_WATSONX_API_KEY, IBM_WATSONX_PROJECT_ID, and IBM_WATSONX_BASE_URL environment variables are required for WatsonX models")
            return WatsonX(
                id=model,
                url=env.get("IBM_WATSONX_BASE_URL"),
                api_key=env.get("IBM_WATSONX_API_KEY"),
                project_id=env.get("IBM_WATSONX_PROJECT_ID"),
            )
        case _:
            return Ollama(id="qwen2.5:latest")  # Default to Ollama
        
def create_cli_parser() -> argparse.ArgumentParser:
    """
    Create a command-line argument parser with common agent options.
    
    Returns:
        argparse.ArgumentParser: Configured argument parser
    """
    parser = argparse.ArgumentParser(description="Run an interactive agent CLI")
    
    parser.add_argument(
        "--model-id", 
        type=str,
        default="openai:gpt-4o",
        help="Model identifier in the format 'provider:model'. Supported providers: "
             "ollama (e.g., ollama:qwen2.5:latest), "
             "openai (e.g., openai:gpt-4o), "
             "anthropic (e.g., anthropic:claude-3-sonnet), "
             "watsonx (e.g., watsonx:granite-13b)"
    )
    
    parser.add_argument(
        "--stream",
        action="store_true",
        help="Enable streaming mode for response generation"
    )
    
    return parser