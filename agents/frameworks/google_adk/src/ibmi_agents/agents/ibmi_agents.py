#!/usr/bin/env python3
"""
IBM i Agent CLI - Google ADK Framework Implementation

This module provides a command-line interface for running IBM i agents
built with the Google ADK framework. It supports running different types
of agents for various IBM i system administration and monitoring tasks.

Available Agents:
- Performance Agent: System performance monitoring and analysis
- Security Agent: Security analysis and vulnerability detection
- System Administration Discovery Agent: High-level system discovery and summarization
- System Administration Browse Agent: Detailed system browsing and exploration
- System Administration Search Agent: System search and lookup capabilities

Each agent uses Google ADK abstractions for LLMs, MCP tools, and reasoning.

Usage:
  uv run ibmi_agents.py --agent performance --verbose
  uv run ibmi_agents.py --agent discovery --model gpt-4
  uv run ibmi_agents.py --agent browse --query "Show me active jobs"
  uv run ibmi_agents.py --agent search --query "Find library QSYS2"
  uv run ibmi_agents.py --agent performance --query "Show CPU usage" --quiet
  uv run ibmi_agents.py --list-agents

Environment Variables:
  IBMI_MCP_ACCESS_TOKEN: Required token for MCP server authentication
  IBMI_MCP_SERVER_URL: Optional URL for MCP server (default: http://127.0.0.1:3010/mcp)
  IBMI_AGENT_MODEL: Optional LLM model to use (default: gemini-2.5-flash)
  IBMI_AGENT_LOG_LEVEL: Optional logging level (default: INFO)

Dependencies:
- google-adk: Google Agent Development Kit
- ibmi-agent-sdk: IBM i Agent SDK with Google ADK integration
- python-dotenv: For loading environment variables

Installation:
    Using uv (recommended):
        uv add google-adk ibmi-agent-sdk python-dotenv
    
    Using pip:
        pip install google-adk ibmi-agent-sdk python-dotenv
"""
import os
import asyncio
import logging
import sys
import argparse
import uuid
from pathlib import Path
from typing import Optional, Dict, Any, Tuple

# Add parent directories to path to allow imports from adk_agents
current_dir = Path(__file__).resolve().parent
google_adk_dir = current_dir.parent.parent.parent
if str(google_adk_dir) not in sys.path:
    sys.path.insert(0, str(google_adk_dir))

# Import Google ADK dependencies
try:
    from adk_agents.sub_agents.performance_agent import get_performance_agent
    from adk_agents.sub_agents.security_agent import get_security_agent
    from adk_agents.sub_agents.sysadmin_search import get_search_agent
    from adk_agents.sub_agents.sysadmin_browse import get_browse_agent
    from adk_agents.sub_agents.sysadmin_discover import get_discover_agent
    from google.adk.agents.llm_agent import LlmAgent
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService
    from google.genai import types
    from google.adk.models.lite_llm import LiteLlm
except ImportError as e:
    print(f"Error: Missing required dependencies. Run: pip install google-adk ibmi-agent-sdk")
    print(f"Details: {e}")
    sys.exit(1)

try:
    from dotenv import load_dotenv
except ImportError:
    print("Warning: python-dotenv not installed. Environment variables must be set manually.")
    def load_dotenv():
        pass

# Logger will be configured by setup_logging()
logger = logging.getLogger(__name__)

# Define available agent types with descriptions
AVAILABLE_AGENTS = {
    "performance": {
        "create_fn": get_performance_agent,
        "description": "Analyzes IBM i performance metrics and suggests optimizations"
    },
    "security": {
        "create_fn": get_security_agent,
        "description": "Analyzes IBM i security configuration and identifies vulnerabilities"
    },
    "discovery": {
        "create_fn": get_discover_agent,
        "description": "Discovers IBM i services, schemas, and system structure"
    },
    "browse": {
        "create_fn": get_browse_agent,
        "description": "Explores and navigates IBM i system objects and libraries"
    },
    "search": {
        "create_fn": get_search_agent,
        "description": "Searches for specific IBM i objects and provides quick lookups"
    }
}

# ============================================================
#  CONFIGURATION AND LOGGING
# ============================================================

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
        for logger_name in ["httpx", "httpcore", "google", "google_adk", "google_genai", "litellm", "mcp", "src.ibmi_agents"]:
            logging.getLogger(logger_name).setLevel(logging.CRITICAL)
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
        "agent_model": os.getenv("IBMI_AGENT_MODEL", "gemini-2.5-flash"),
        "log_level": os.getenv("IBMI_AGENT_LOG_LEVEL", "INFO")
    }


# ============================================================
#  AGENT CREATION FACTORY
# ============================================================

def create_agent(agent_type: str, debug_filtering: bool = False) -> Tuple[LlmAgent, Any]:
    """
    Factory function to create an agent of the specified type.
    
    Args:
        agent_type: Type of agent to create (performance, discovery, etc.)
        debug_filtering: Whether to enable debug output for tool filtering
        
    Returns:
        Tuple[LlmAgent, Any]: Configured agent and its toolset
        
    Raises:
        ValueError: If the agent type is unknown or MCP token is missing
        ConnectionError: If connection to MCP server fails
    """
    if agent_type not in AVAILABLE_AGENTS:
        available = ', '.join(AVAILABLE_AGENTS.keys())
        raise ValueError(f"Unknown agent type: {agent_type}. Available types: {available}")
    
    return AVAILABLE_AGENTS[agent_type]["create_fn"](debug_filtering)


# ============================================================
#  CHAT WITH AGENT
# ============================================================

async def chat_with_agent(agent: LlmAgent, query: str, agent_name: str, verbose: bool = False, quiet: bool = False) -> str:
    """
    Send a query to an agent and get the response.
    
    Args:
        agent: The LlmAgent to query
        query: The query string to send
        agent_name: Name of the agent for session identification
        verbose: Whether to show verbose output
        quiet: Whether to suppress all non-essential output
        
    Returns:
        str: The agent's response text
        
    Raises:
        Exception: If the agent fails to process the query
    """
    try:
        if not quiet:
            logger.info(f"Sending query to agent: {query}")
        
        # Create a unique session ID
        session_id = str(uuid.uuid4())
        user_id = f"cli_user_{session_id[:8]}"
        app_name = f"ibmi_agent_{agent_name}"
        
        # Set up session service
        if not quiet:
            logger.debug("Setting up session service...")
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
        
        # Process events and get final response
        final_response = ""
        async for event in event_generator:
            if verbose and not quiet:
                logger.debug(f"Event: {event}")
            if event.is_final_response():
                final_response = event.content.parts[0].text
                break
        
        return final_response
    except Exception as e:
        logger.error(f"Error in agent chat: {str(e)}")
        raise


# ============================================================
#  CLI FUNCTIONS
# ============================================================

def list_agents() -> None:
    """Print a list of available agents and their descriptions."""
    print("\nAvailable IBM i Agents:")
    print("======================")
    for agent_name, agent_info in AVAILABLE_AGENTS.items():
        print(f"- {agent_name}: {agent_info['description']}")
    print()


async def run_agent(agent_name: str, query: Optional[str], verbose: bool = False, quiet: bool = False) -> None:
    """Run the specified agent with the given query."""
    if agent_name not in AVAILABLE_AGENTS:
        if not quiet:
            logger.error(f"Unknown agent: {agent_name}")
            list_agents()
        else:
            print(f"Error: Unknown agent '{agent_name}'")
        return
    
    try:
        if not quiet:
            logger.info(f"Creating {agent_name} agent...")
        
        agent, toolset = create_agent(agent_name, debug_filtering=verbose)
        
        try:
            if not query:
                if not quiet:
                    logger.info(f"Agent {agent_name} created successfully. Use --query to interact with it.")
                return
            
            if not quiet:
                logger.info(f"Running query: {query}")
            
            # Run the query
            final_response = await chat_with_agent(agent, query, agent_name, verbose, quiet)
            
            # Display response
            if quiet:
                # In quiet mode, only print the final response
                print(final_response)
            else:
                print("\nAgent Response:")
                print("==============")
                print(final_response)
                logger.info("Agent run complete.")
        finally:
            # Always close the toolset connection
            await toolset.close()
        
    except Exception as e:
        if quiet:
            print(f"Error: {str(e)}")
        else:
            logger.error(f"Error running agent: {str(e)}", exc_info=verbose)
            if verbose:
                import traceback
                traceback.print_exc()


def create_argument_parser() -> argparse.ArgumentParser:
    """Create and configure the argument parser."""
    parser = argparse.ArgumentParser(
        description="IBM i Agent CLI - Interact with IBM i systems using specialized AI agents",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --agent performance --query "Show me system CPU usage"
  %(prog)s --agent search --query "Find QSYS2 services" --quiet
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


# ============================================================
#  MAIN ENTRY POINT
# ============================================================

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
            list_agents()
            return
        
        if args.agent:
            await run_agent(args.agent, args.query, args.verbose, args.quiet)
            return
        
        parser.print_help()
            
    except Exception as e:
        handle_error(e, args.verbose if hasattr(args, 'verbose') else False,
                    args.quiet if hasattr(args, 'quiet') else False)


if __name__ == "__main__":
    asyncio.run(main())
