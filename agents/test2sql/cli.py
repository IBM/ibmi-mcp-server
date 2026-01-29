"""
CLI entry point for the IBM i Text-to-SQL Agent.

Provides an interactive command-line interface for querying IBM i databases
using natural language.

Usage:
    python cli.py                                # Interactive mode
    python cli.py -p "What tables are in QIWS?"  # Single query mode
"""

import argparse
import asyncio

from text2sql_agent import agent


async def main(initial_prompt: str | None = None):
    """Run the Text-to-SQL agent.

    Args:
        initial_prompt: Optional initial prompt to process before interactive mode.
    """
    if initial_prompt:
        # Process single query and exit
        response = await agent.arun(initial_prompt, stream=False, markdown=True)
        print(response.content)
    else:
        # Interactive mode
        await agent.acli_app(stream=True, markdown=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="IBM i Text-to-SQL Agent - Query your IBM i database using natural language"
    )
    parser.add_argument(
        "-p", "--prompt",
        type=str,
        help="Process a single prompt and exit (omit for interactive mode)",
        default=None,
    )
    args = parser.parse_args()

    asyncio.run(main(args.prompt))
