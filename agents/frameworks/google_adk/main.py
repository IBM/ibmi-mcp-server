#!/usr/bin/env python3
"""
IBM i Agent CLI - Google ADK Framework Implementation

This module provides a command-line interface for running IBM i agents
built with the Google ADK framework. It supports running different types
of agents for various IBM i system administration and monitoring tasks.

Usage:
  uv run main.py --agent performance --verbose
  uv run main.py --agent sysadmin_discovery --model gpt-4
  uv run main.py --agent sysadmin_browse --query "Show me active jobs"
  uv run main.py --agent sysadmin_search --query "Find library QSYS2"
  uv run main.py --agent performance --query "Show CPU usage" --quiet
  uv run main.py --list-agents

Environment Variables:
  IBMI_MCP_ACCESS_TOKEN: Required token for MCP server authentication
  IBMI_MCP_SERVER_URL: Optional URL for MCP server (default: http://127.0.0.1:3010/mcp)
  IBMI_AGENT_MODEL: Optional LLM model to use (default: watsonx/meta-llama/llama-3-3-70b-instruct)
  IBMI_AGENT_LOG_LEVEL: Optional logging level (default: INFO)
"""

import os
import sys
import asyncio
import argparse
import logging
from typing import Optional, Dict, Any

try:
    from dotenv import load_dotenv
except ImportError:
    print("Warning: python-dotenv not installed. Environment variables must be set manually.")
    def load_dotenv():
        pass

# Import agent creation functions
from src.ibmi_agents.agents.ibmi_agents import (
    create_performance_agent,
    create_sysadmin_discovery_agent,
    create_sysadmin_browse_agent,
    create_sysadmin_search_agent
)

# Import Google ADK dependencies
try:
    from google.adk.sessions import InMemorySessionService
    from google.adk.runners import Runner
    from google.genai import types
except ImportError:
    print("Warning: Google ADK dependencies not installed. Run: pip install google-adk")

# Define available agents
AVAILABLE_AGENTS = {
    "performance": {
        "create_fn": create_performance_agent,
        "description": "Analyzes IBM i performance metrics and suggests optimizations"
    },
    "sysadmin_discovery": {
        "create_fn": create_sysadmin_discovery_agent,
        "description": "Discovers IBM i services, schemas, and system structure"
    },
    "sysadmin_browse": {
        "create_fn": create_sysadmin_browse_agent,
        "description": "Explores and navigates IBM i system objects and libraries"
    },
    "sysadmin_search": {
        "create_fn": create_sysadmin_search_agent,
        "description": "Searches for specific IBM i objects and provides quick lookups"
    }
}

# Configure logging
def setup_logging(log_level: str = "INFO", quiet: bool = False) -> None:
    """Configure logging with the specified log level."""
    if quiet:
        # In quiet mode, suppress all logging except CRITICAL errors
        logging.basicConfig(
            level=logging.CRITICAL,
            format="%(message)s",
            handlers=[logging.StreamHandler()]
        )
        # Disable specific noisy loggers
        logging.getLogger("httpx").setLevel(logging.CRITICAL)
        logging.getLogger("httpcore").setLevel(logging.CRITICAL)
        logging.getLogger("google").setLevel(logging.CRITICAL)
        logging.getLogger("google_adk").setLevel(logging.CRITICAL)
        logging.getLogger("google_genai").setLevel(logging.CRITICAL)
        logging.getLogger("litellm").setLevel(logging.CRITICAL)
        logging.getLogger("mcp").setLevel(logging.CRITICAL)
        logging.getLogger("src.ibmi_agents").setLevel(logging.CRITICAL)
        # Suppress warnings
        import warnings
        warnings.filterwarnings("ignore")
        return
    
    numeric_level = getattr(logging, log_level.upper(), None)
    if not isinstance(numeric_level, int):
        raise ValueError(f"Invalid log level: {log_level}")
    
    logging.basicConfig(
        level=numeric_level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[logging.StreamHandler()]
    )

# Load configuration from environment variables
def load_config() -> Dict[str, Any]:
    """Load configuration from environment variables."""
    load_dotenv()
    
    # Check for required environment variables
    token = os.getenv("IBMI_MCP_ACCESS_TOKEN")
    if not token:
        raise ValueError("Missing IBMI_MCP_ACCESS_TOKEN in environment variables")
    
    return {
        "mcp_token": token,
        "mcp_server_url": os.getenv("IBMI_MCP_SERVER_URL", "http://127.0.0.1:3010/mcp"),
        "agent_model": os.getenv("IBMI_AGENT_MODEL", "watsonx/meta-llama/llama-3-3-70b-instruct"),
        "log_level": os.getenv("IBMI_AGENT_LOG_LEVEL", "INFO")
    }

# List available agents
def list_agents() -> None:
    """Print a list of available agents and their descriptions."""
    print("\nAvailable IBM i Agents:")
    print("======================")
    for agent_name, agent_info in AVAILABLE_AGENTS.items():
        print(f"- {agent_name}: {agent_info['description']}")
    print()

# Run an agent with the given query
async def run_agent(agent_name: str, query: Optional[str], verbose: bool = False, quiet: bool = False) -> None:
    """Run the specified agent with the given query."""
    logger = logging.getLogger("ibmi_agent")
    
    if agent_name not in AVAILABLE_AGENTS:
        if not quiet:
            logger.error(f"Unknown agent: {agent_name}")
            list_agents()
        else:
            print(f"Error: Unknown agent '{agent_name}'")
        return
    
    try:
        # Create a unique session ID
        import uuid
        session_id = str(uuid.uuid4())
        user_id = f"cli_user_{session_id[:8]}"
        app_name = f"ibmi_agent_{agent_name}"
        
        if not quiet:
            logger.info(f"Creating {agent_name} agent...")
        agent, toolset = await AVAILABLE_AGENTS[agent_name]["create_fn"](debug_filtering=verbose)
        
        try:
            if not query:
                if not quiet:
                    logger.info(f"Agent {agent_name} created successfully. Use --query to interact with it.")
                return
            
            if not quiet:
                logger.info(f"Running query: {query}")
                logger.debug("Setting up session service...")
            
            # Set up session service
            session_service = InMemorySessionService()
            await session_service.create_session(app_name=app_name, user_id=user_id, session_id=session_id)
            
            # Create runner
            if not quiet:
                logger.debug("Creating runner...")
            runner = Runner(app_name=app_name, agent=agent, session_service=session_service)
            
            # Format query as Content
            content = types.Content(role='user', parts=[types.Part(text=query)])
            
            # Run the agent
            if not quiet:
                logger.debug("Running agent...")
                print("\nProcessing query, please wait...\n")
            
            event_generator = runner.run_async(user_id=user_id, session_id=session_id, new_message=content)
            
            # Process events
            async for event in event_generator:
                if verbose and not quiet:
                    logger.debug(f"Event: {event}")
                if event.is_final_response():
                    final_response = event.content.parts[0].text
                    if quiet:
                        # In quiet mode, only print the final response
                        print(final_response)
                    else:
                        print("\nAgent Response:")
                        print("==============")
                        print(final_response)
            
            if not quiet:
                logger.info("Agent run complete.")
        finally:
            # Always close the toolset connection, even if an exception occurs
            await toolset.close()
        
    except Exception as e:
        if quiet:
            print(f"Error: {str(e)}")
        else:
            logger.error(f"Error running agent: {str(e)}", exc_info=verbose)
            if verbose:
                import traceback
                traceback.print_exc()

# Main function
def create_argument_parser() -> argparse.ArgumentParser:
    """Create and configure the argument parser."""
    parser = argparse.ArgumentParser(
        description="IBM i Agent CLI - Interact with IBM i systems using specialized AI agents",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --agent performance --query "Show me system CPU usage"
  %(prog)s --agent sysadmin_search --query "Find QSYS2 services" --quiet
  %(prog)s --list-agents
        """
    )
    parser.add_argument("--agent", help="Agent type to run")
    parser.add_argument("--query", help="Query to send to the agent")
    
    verbosity_group = parser.add_mutually_exclusive_group()
    verbosity_group.add_argument("--verbose", action="store_true", help="Enable verbose output with detailed logging")
    verbosity_group.add_argument("--quiet", action="store_true", help="Quiet mode - only show final response without logs")
    
    parser.add_argument("--list-agents", action="store_true", help="List available agents")
    parser.add_argument("--model", help="Override the LLM model to use")
    
    return parser

def apply_model_override(model: str, quiet: bool) -> None:
    """Apply model override to environment."""
    os.environ["IBMI_AGENT_MODEL"] = model
    if not quiet:
        logger = logging.getLogger("ibmi_agent")
        logger.info(f"Using model: {model}")

def determine_log_level(verbose: bool, config: Dict[str, Any]) -> str:
    """Determine the appropriate log level."""
    return "DEBUG" if verbose else config["log_level"]

def handle_error(error: Exception, verbose: bool, quiet: bool) -> None:
    """Handle and display errors appropriately."""
    if quiet:
        print(f"Error: {str(error)}")
    else:
        logging.error(f"Error: {str(error)}")
        if verbose:
            import traceback
            traceback.print_exc()
    sys.exit(1)

async def execute_list_agents_flow() -> None:
    """Execute the list agents workflow."""
    list_agents()

async def execute_run_agent_flow(agent: str, query: Optional[str], verbose: bool, quiet: bool) -> None:
    """Execute the run agent workflow."""
    await run_agent(agent, query, verbose, quiet)

def display_help(parser: argparse.ArgumentParser) -> None:
    """Display help information."""
    parser.print_help()

async def main() -> None:
    """Main entry point for the CLI."""
    parser = create_argument_parser()
    args = parser.parse_args()
    
    try:
        config = load_config()
        log_level = determine_log_level(args.verbose, config)
        setup_logging(log_level, quiet=args.quiet)
        
        if args.model:
            apply_model_override(args.model, args.quiet)
        
        if args.list_agents:
            await execute_list_agents_flow()
            return
        
        if args.agent:
            await execute_run_agent_flow(args.agent, args.query, args.verbose, args.quiet)
            return
        
        display_help(parser)
            
    except Exception as e:
        handle_error(e, args.verbose, args.quiet)

if __name__ == "__main__":
    asyncio.run(main())
