#!/usr/bin/env python3
"""
IBM i Agent CLI

A simple command-line interface for running IBM i specialized agents.
Each agent connects to the MCP server over HTTP for tool access.

Usage:
    # List available agents
    python ibmi_agentos.py --list

    # Run a specific agent interactively
    python ibmi_agentos.py --agent performance
    python ibmi_agentos.py --agent discovery
    python ibmi_agentos.py --agent browse
    python ibmi_agentos.py --agent search

    # Run with custom MCP server URL
    python ibmi_agentos.py --agent performance --mcp-url http://localhost:3010/mcp

    # Enable debug mode
    python ibmi_agentos.py --agent performance --debug

Examples:
    # Quick start with performance agent
    python ibmi_agentos.py -a performance

    # Discovery agent with debug output
    python ibmi_agentos.py -a discovery --debug
"""

import asyncio
import sys
from argparse import ArgumentParser

from dotenv import load_dotenv
from agno.agent import Agent

from ibmi_agents.agents import (
    get_performance_agent,
    get_sysadmin_discovery_agent,
    get_sysadmin_browse_agent,
    get_sysadmin_search_agent,
    get_web_agent,
    get_agno_assist,
    DEFAULT_MCP_URL,
    DEFAULT_TRANSPORT,
)

# Load environment variables (for API keys, etc.)
load_dotenv()


# Available agents with descriptions
AVAILABLE_AGENTS = {
    "performance": {
        "factory": get_performance_agent,
        "name": "IBM i Performance Monitor",
        "description": "System performance monitoring and analysis",
        "uses_mcp": True,
    },
    "discovery": {
        "factory": get_sysadmin_discovery_agent,
        "name": "IBM i SysAdmin Discovery",
        "description": "High-level system discovery and summarization",
        "uses_mcp": True,
    },
    "browse": {
        "factory": get_sysadmin_browse_agent,
        "name": "IBM i SysAdmin Browser",
        "description": "Detailed system browsing and exploration",
        "uses_mcp": True,
    },
    "search": {
        "factory": get_sysadmin_search_agent,
        "name": "IBM i SysAdmin Search",
        "description": "System search and lookup capabilities",
        "uses_mcp": True,
    },
    "web": {
        "factory": get_web_agent,
        "name": "Web Search Agent",
        "description": "Web search agent for general information gathering",
        "uses_mcp": False,
    },
    "agno-assist": {
        "factory": get_agno_assist,
        "name": "Agno Assist",
        "description": "Agno framework assistant for learning and development",
        "uses_mcp": False,
    },
}


def list_agents():
    """Display all available agents and their descriptions."""
    print("\n=== Available IBM i Agents ===\n")
    for agent_name, agent_info in AVAILABLE_AGENTS.items():
        mcp_indicator = "🔗 MCP" if agent_info["uses_mcp"] else "   "
        human_name = agent_info["name"]
        print(f"  {mcp_indicator} [{agent_name}] - {human_name}")
        print(f"      └─ {agent_info['description']}")
    print("\n🔗 = Uses MCP server for tools")
    print("\n" + "=" * 60)
    print("Usage: python ibmi_agentos.py --agent <agent_key>")
    print("=" * 60)
    print("\nAvailable agent keys (use these with --agent):")
    print(f"  {', '.join(AVAILABLE_AGENTS.keys())}")
    print("\nExample: python ibmi_agentos.py --agent performance")
    print("         python ibmi_agentos.py -a discovery\n")


async def run_agent(
    agent_name: str,
    mcp_url: str = DEFAULT_MCP_URL,
    transport: str = DEFAULT_TRANSPORT,
    debug: bool = False,
    debug_filtering: bool = False,
    model: str = "gpt-4o",
):
    """
    Run a specific agent interactively.

    Args:
        agent_name: Name of the agent to run
        mcp_url: MCP server URL
        transport: MCP transport type
        debug: Enable debug mode
        debug_filtering: Enable debug filtering for MCP tools
        model: Model to use for the agent
    """
    if agent_name not in AVAILABLE_AGENTS:
        print(f"❌ Error: Unknown agent '{agent_name}'")
        print(f"\nAvailable agents: {', '.join(AVAILABLE_AGENTS.keys())}")
        print("\nUse --list to see full details")
        sys.exit(1)

    agent_info = AVAILABLE_AGENTS[agent_name]
    factory = agent_info["factory"]

    print(f"\n🚀 Starting {agent_name} agent...")
    print(f"📝 Description: {agent_info['description']}")

    # Build agent kwargs based on whether it uses MCP
    kwargs = {
        "debug_mode": debug,
        "model": model,
    }

    if agent_info["uses_mcp"]:
        kwargs.update(
            {
                "mcp_url": mcp_url,
                "transport": transport,
                "debug_filtering": debug_filtering,
            }
        )
        print(f"🔗 MCP Server: {mcp_url}")

    print(f"🤖 Model: {model}")

    if debug:
        print("🐛 Debug mode: enabled")

    print("\n" + "=" * 60)
    print("Starting interactive session...")
    print("Type 'exit' or 'quit' to end the session")
    print("=" * 60 + "\n")

    # Create and run the agent
    agent: Agent = factory(**kwargs)

    # Run the agent's CLI interface
    await agent.acli_app(markdown=True)


def main():
    """Main entry point for the CLI."""
    parser = ArgumentParser(
        description="IBM i Agent CLI - Run specialized agents for IBM i system administration",
        epilog="Examples:\n"
        "  python ibmi_agentos.py --list\n"
        "  python ibmi_agentos.py --agent performance\n"
        "  python ibmi_agentos.py -a discovery --debug\n",
    )

    parser.add_argument(
        "--list",
        action="store_true",
        help="List all available agents and exit",
    )

    parser.add_argument(
        "--agent",
        "-a",
        type=str,
        help="Agent to run (e.g., performance, discovery, browse, search)",
    )

    parser.add_argument(
        "--mcp-url",
        type=str,
        default=DEFAULT_MCP_URL,
        help=f"MCP server URL (default: {DEFAULT_MCP_URL})",
    )

    parser.add_argument(
        "--transport",
        type=str,
        default=DEFAULT_TRANSPORT,
        help=f"MCP transport type (default: {DEFAULT_TRANSPORT})",
    )

    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug mode for the agent",
    )

    parser.add_argument(
        "--debug-filtering",
        action="store_true",
        help="Enable debug filtering for MCP tools",
    )

    parser.add_argument(
        "--model",
        type=str,
        default="openai:gpt-4o",
        help="Model to use for the agent (default: gpt-4o)",
    )

    args = parser.parse_args()

    # Handle --list command
    if args.list:
        list_agents()
        sys.exit(0)

    # Require --agent if not listing
    if not args.agent:
        parser.print_help()
        print("\n❌ Error: --agent is required (or use --list to see available agents)")
        sys.exit(1)

    # Run the selected agent
    asyncio.run(
        run_agent(
            agent_name=args.agent,
            mcp_url=args.mcp_url,
            transport=args.transport,
            debug=args.debug,
            debug_filtering=args.debug_filtering,
            model=args.model,
        )
    )


if __name__ == "__main__":
    main()
