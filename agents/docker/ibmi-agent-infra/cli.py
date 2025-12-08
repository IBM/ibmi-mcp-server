#!/usr/bin/env python3
"""
CLI for running agents-infra agents, teams, and workflows locally without Docker/PostgreSQL.

Usage:
    # List agents, teams, and workflows
    python cli.py --list-agents
    python cli.py --list-teams
    python cli.py --list-workflows

    # Run agents
    python cli.py --agent web-search
    python cli.py --agent metrics --model-id watsonx:mistralai/mistral-large --stream
    python cli.py --agent ptf --debug

    # Run teams
    python cli.py --team ptf-team
    python cli.py --team performance-routing --stream

    # Run workflows
    python cli.py --workflow quick-performance --prompt "Check system performance"
    python cli.py --workflow comprehensive-analysis --prompt "Analyze bottlenecks" --debug
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Set SQLite mode BEFORE importing any agents
# This prevents PostgreSQL import errors
os.environ["USE_SQLITE"] = "true"
os.environ["SQLITE_DB_PATH"] = str(Path(__file__).parent / "tmp" / "agents.db")

# Import agents, teams, and workflows with error handling for missing dependencies
# Items with missing dependencies will be excluded from the registry

from agno.workflow import Workflow
from agents.utils.model_selector import COMMON_MODELS

AGENTS = {}
TEAMS = {}
WORKFLOWS = {}

# Import IBM i agents to trigger registration
# This must happen before we call get_all_agents()
try:
    import agents.ibmi_agents  # noqa: F401 - importing for side effects (registration)
    from agents.registry import get_all_agents

    # Auto-discover all registered agents
    for agent_id, registration in get_all_agents().items():
        metadata = registration.metadata
        AGENTS[agent_id] = {
            "name": metadata.name,
            "description": metadata.description,
            "factory": registration.factory,
        }

    print(f"✓ Loaded {len(AGENTS)} IBM i agents", file=sys.stderr)

except ImportError as e:
    print(f"Warning: Failed to load IBM i agents - {e}", file=sys.stderr)


def list_agents():
    """Print table of available agents."""
    print("\nAvailable Agents:")
    print("=" * 80)
    print(f"{'Agent ID':<25} {'Name':<35} {'Description'}")
    print("-" * 80)

    for agent_id, agent_info in sorted(AGENTS.items()):
        print(f"{agent_id:<25} {agent_info['name']:<35} {agent_info['description']}")

    print("=" * 80)
    print(f"\nTotal: {len(AGENTS)} agents available\n")


def list_teams():
    """Print table of available teams."""
    print("\nAvailable Teams:")
    print("=" * 80)
    print(f"{'Team ID':<25} {'Name':<35} {'Description'}")
    print("-" * 80)

    for team_id, team_info in sorted(TEAMS.items()):
        print(f"{team_id:<25} {team_info['name']:<35} {team_info['description']}")

    print("=" * 80)
    print(f"\nTotal: {len(TEAMS)} teams available\n")


def list_workflows():
    """Print table of available workflows."""
    print("\nAvailable Workflows:")
    print("=" * 80)
    print(f"{'Workflow ID':<25} {'Name':<35} {'Description'}")
    print("-" * 80)

    for workflow_id, workflow_info in sorted(WORKFLOWS.items()):
        print(
            f"{workflow_id:<25} {workflow_info['name']:<35} {workflow_info['description']}"
        )

    print("=" * 80)
    print(f"\nTotal: {len(WORKFLOWS)} workflows available\n")


async def run_agent(agent_id: str, args):
    """
    Run the specified agent with given configuration.

    Args:
        agent_id: Agent identifier from AGENTS registry
        args: Parsed command-line arguments
    """
    if agent_id not in AGENTS:
        print(f"Error: Unknown agent '{agent_id}'")
        print(f"Use --list-agents to see available agents")
        sys.exit(1)

    agent_info = AGENTS[agent_id]

    # Import AgentRunConfig and AgentConfigManager here to avoid circular imports
    from agents.config import AgentRunConfig
    from infra.config_manager import AgentConfigManager

    # Build configuration from CLI args
    config = AgentRunConfig(
        model=args.model_id,
        debug_mode=args.debug,
        enable_reasoning=args.enable_reasoning,
        debug_filtering=args.debug_filtering,
        mcp_url=args.mcp_url,
        transport=args.mcp_transport,
        config_manager=AgentConfigManager(args.config_file) if args.config_file else None,
    )

    print(f"\n{'='*80}")
    print(f"Starting: {agent_info['name']}")
    print(f"Model: {config.model}")
    print(f"Storage: SQLite (tmp/agents.db)")
    print(f"Debug: {config.debug_mode}")
    print(f"Reasoning: {config.enable_reasoning}")
    print(f"Stream: {args.stream}")
    if config.mcp_url:
        print(f"MCP URL: {config.mcp_url}")
    if config.config_manager:
        print(f"Config File: {args.config_file}")
    print(f"{'='*80}\n")

    # Create agent instance
    agent = agent_info["factory"](config=config)

    # Run interactive CLI using Agno's built-in CLI
    await agent.acli_app(markdown=True, stream=args.stream)


def run_team(team_id: str, model_id: str, debug: bool, stream: bool):
    """
    Run the specified team with given configuration.

    Args:
        team_id: Team identifier from TEAMS registry
        model_id: Model specification (e.g., "openai:gpt-4o")
        debug: Enable debug mode
        stream: Enable streaming responses
    """
    if team_id not in TEAMS:
        print(f"Error: Unknown team '{team_id}'")
        print(f"Use --list-teams to see available teams")
        sys.exit(1)

    team_info = TEAMS[team_id]

    print(f"\n{'='*80}")
    print(f"Starting: {team_info['name']}")
    print(f"Model: {model_id}")
    print(f"Storage: SQLite (tmp/agents.db)")
    print(f"Debug: {debug}")
    print(f"Stream: {stream}")
    print(f"{'='*80}\n")

    # Create team instance
    team = team_info["factory"](
        model=model_id,
        debug_mode=debug,
    )

    # Run interactive CLI using Agno's built-in CLI
    team.cli_app(markdown=True, stream=stream)


async def run_workflow(
    workflow_id: str, model_id: str, debug: bool, user_input: str, stream: bool = False
):
    """
    Run the specified workflow with given configuration.

    Args:
        workflow_id: Workflow identifier from WORKFLOWS registry
        model_id: Model specification (e.g., "openai:gpt-4o")
        debug: Enable debug mode
        user_input: User input/query for the workflow
    """
    if workflow_id not in WORKFLOWS:
        print(f"Error: Unknown workflow '{workflow_id}'")
        print(f"Use --list-workflows to see available workflows")
        sys.exit(1)

    workflow_info = WORKFLOWS[workflow_id]

    print(f"\n{'='*80}")
    print(f"Starting: {workflow_info['name']}")
    print(f"Model: {model_id}")
    print(f"Storage: SQLite (tmp/agents.db)")
    print(f"Debug: {debug}")
    print(f"Input: {user_input}")
    print(f"{'='*80}\n")

    # Create workflow instance
    workflow: Workflow = workflow_info["factory"](
        model=model_id,
        debug_mode=debug,
    )

    # Run workflow with user input
    await workflow.aprint_response(user_input, stream=stream)


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="CLI for running agents-infra agents, teams, and workflows locally",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
Examples:
  # List all available agents, teams, and workflows
  python cli.py --list-agents
  python cli.py --list-teams
  python cli.py --list-workflows

  # Run an agent
  python cli.py --agent web-search
  python cli.py --agent metrics --model-id watsonx:mistralai/mistral-large --stream
  python cli.py --agent ptf --debug

  # Run a team
  python cli.py --team ptf-team
  python cli.py --team performance-routing --model-id anthropic:claude-sonnet-4-5
  python cli.py --team performance-collaboration --stream

  # Run a workflow
  python cli.py --workflow quick-performance --prompt "Check system performance"
  python cli.py --workflow comprehensive-analysis --prompt "Analyze performance bottlenecks"
  python cli.py --workflow iterative-analysis --prompt "Find and fix performance issues" --debug
  
  Common model specifications:
{''.join([f"    {alias:<15} ({spec})\n" for alias, spec in COMMON_MODELS.items()])}
        """,
    )

    parser.add_argument(
        "--agent",
        type=str,
        help="Agent to run (use --list-agents to see options)",
    )

    parser.add_argument(
        "--team",
        type=str,
        help="Team to run (use --list-teams to see options)",
    )

    parser.add_argument(
        "--workflow",
        type=str,
        help="Workflow to run (use --list-workflows to see options)",
    )

    parser.add_argument(
        "--prompt",
        type=str,
        help="Input/query for the workflow (required when using --workflow)",
    )

    parser.add_argument(
        "--model-id",
        type=str,
        default="openai:gpt-4o",
        help="Model specification (default: openai:gpt-4o). Format: provider:model",
    )

    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug mode for verbose output",
    )

    parser.add_argument(
        "--stream",
        action="store_true",
        help="Enable streaming responses",
    )

    parser.add_argument(
        "--enable-reasoning",
        dest="enable_reasoning",
        action="store_true",
        default=True,
        help="Enable reasoning tools for structured analysis (default: True)",
    )

    parser.add_argument(
        "--disable-reasoning",
        dest="enable_reasoning",
        action="store_false",
        help="Disable reasoning tools",
    )

    parser.add_argument(
        "--debug-filtering",
        action="store_true",
        help="Enable debug output for tool filtering",
    )

    parser.add_argument(
        "--mcp-url",
        type=str,
        help="Override MCP server URL",
    )

    parser.add_argument(
        "--mcp-transport",
        type=str,
        help="Override MCP transport type (e.g., 'streamable-http', 'sse')",
    )

    parser.add_argument(
        "--config-file",
        type=str,
        help="Load agent configuration from YAML file",
    )

    parser.add_argument(
        "--list-agents",
        action="store_true",
        help="List all available agents and exit",
    )

    parser.add_argument(
        "--list-teams",
        action="store_true",
        help="List all available teams and exit",
    )

    parser.add_argument(
        "--list-workflows",
        action="store_true",
        help="List all available workflows and exit",
    )

    args = parser.parse_args()

    # Handle --list-agents
    if args.list_agents:
        list_agents()
        sys.exit(0)

    # Handle --list-teams
    if args.list_teams:
        list_teams()
        sys.exit(0)

    # Handle --list-workflows
    if args.list_workflows:
        list_workflows()
        sys.exit(0)

    # Count how many run modes are specified
    run_modes = sum([bool(args.agent), bool(args.team), bool(args.workflow)])

    # Ensure --agent, --team, and --workflow are mutually exclusive
    if run_modes > 1:
        parser.print_help()
        print(
            "\nError: --agent, --team, and --workflow are mutually exclusive. Choose one."
        )
        sys.exit(1)

    # Require either --agent, --team, or --workflow
    if run_modes == 0:
        parser.print_help()
        print("\nError: One of --agent, --team, or --workflow is required")
        print("       (or use --list-agents / --list-teams / --list-workflows)")
        sys.exit(1)

    # Validate --workflow requires --prompt
    if args.workflow and not args.prompt:
        parser.print_help()
        print("\nError: --workflow requires --prompt to specify the workflow query")
        sys.exit(1)

    # Ensure tmp directory exists for SQLite database
    tmp_dir = Path(__file__).parent / "tmp"
    tmp_dir.mkdir(exist_ok=True)

    # Run the agent, team, or workflow
    import asyncio
    try:
        if args.agent:
            asyncio.run(run_agent(agent_id=args.agent, args=args))
        elif args.team:
            run_team(
                team_id=args.team,
                model_id=args.model_id,
                debug=args.debug,
                stream=args.stream,
            )
        elif args.workflow:
            asyncio.run(
                run_workflow(
                    workflow_id=args.workflow,
                    model_id=args.model_id,
                    debug=args.debug,
                    user_input=args.prompt,
                    stream=args.stream,
                )
            )
    except KeyboardInterrupt:
        print("\n\nExiting...")
        sys.exit(0)
    except Exception as e:
        print(f"\nError: {e}")
        if args.debug:
            raise
        sys.exit(1)


if __name__ == "__main__":
    main()
