"""
CLI entry point for the IBM i Text-to-SQL Agent.

Provides an interactive command-line interface with tool confirmation
support for sensitive operations like execute_sql.

Usage:
    python cli.py
    python cli.py --prompt "What tables are in QIWS?"
"""

import argparse
import asyncio

from text2sql_agent import agent


async def main():
    """Run the Text-to-SQL agent with confirmation support."""
    await agent.acli_app(stream=True, markdown=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="IBM i Text-to-SQL Agent - Query your IBM i database using natural language"
    )
    parser.add_argument(
        "-p", "--prompt",
        type=str,
        help="Initial prompt to send to the agent",
        default=None,
    )
    args = parser.parse_args()

    asyncio.run(main())
