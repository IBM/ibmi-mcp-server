#!/usr/bin/env python3
"""
IBM i Agent CLI
"""

import argparse
from textwrap import dedent
from agno.agent import Agent
from agno.tools.mcp import MCPTools
import os
from pathlib import Path
from agno.tools.reasoning import ReasoningTools
from agno.memory.v2.db.sqlite import SqliteMemoryDb
from agno.memory.v2.memory import Memory
from agno.storage.sqlite import SqliteStorage
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Import utilities
from utils import get_model

url = "http://127.0.0.1:3010/mcp"


async def create_agent(
    model_id: str = "openai:gpt-4o", debug: bool = True, tools_path: str = None
) -> Agent:
    """
    Create IBM i PTF specialist agent.
    """

    # Get the language model
    model = get_model(model_id)

    # Store agent sessions in a SQLite database
    storage = SqliteStorage(table_name="agent_sessions", db_file="tmp/agent.db")

    memory = Memory(
        # Use any model for creating and managing memories
        model=get_model(model_id),
        # Store memories in a SQLite database
        db=SqliteMemoryDb(table_name="user_memories", db_file="tmp/agent.db"),
        # We disable deletion by default, enable it if needed
        delete_memories=True,
        clear_memories=True,
    )

    # Create MCP tools connection to IBM i
    mcp_env = {
        "MCP_TRANSPORT_TYPE": "stdio",
        "TOOLS_YAML_PATH": os.path.abspath(tools_path),
        "NODE_OPTIONS": "--no-deprecation",
        "DB2i_HOST": os.getenv("DB2i_HOST"),
        "DB2i_USER": os.getenv("DB2i_USER"),
        "DB2i_PASS": os.getenv("DB2i_PASS"),
        "DB2i_PORT": os.getenv("DB2i_PORT", "8076"),
    }

    mcp_tools = MCPTools(url=url, transport="streamable-http")

    await mcp_tools.connect()

    instructions = dedent(
        """
        You are a specialized IBM i System Administrator Expert.
        Use the available tools to assist the user with system administration tasks.
        """
    )

    # Create and return the agent
    return Agent(
        name="IBM i SYS Admin Agent",
        model=model,
        tools=[mcp_tools, ReasoningTools(add_instructions=True, add_few_shot=True)],
        storage=storage,
        memory=memory,
        enable_agentic_memory=True,
        enable_session_summaries=True,
        instructions=instructions,
        description="Specialized IBM i PTF and Technology Refresh management expert",
        markdown=True,
        show_tool_calls=True,
        debug_mode=debug,
        add_history_to_messages=True,
        add_datetime_to_instructions=True,
        num_history_runs=3,
        num_history_responses=3
    )
    
    
async def main():
    """Run this agent interactively."""
    parser = argparse.ArgumentParser(
        description="IBM i MCP Agent Test - Query your IBM i system using natural language"
    )
    parser.add_argument("--tools", default="../../tools", help="Path to tools YAML file")
    print("🚀 Starting IBM i Agent")
    print("=" * 40)

    args = parser.parse_args()

    # Create the agent
    agent = await create_agent(tools_path=args.tools)
    await agent.acli_app()


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
