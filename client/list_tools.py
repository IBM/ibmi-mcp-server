"""
Demo: Connect to an IBM i MCP Server, list tools, and call one.

Usage:
    uv run python list_tools.py
"""

import asyncio
import json
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

SERVER_URL = "http://127.0.0.1:3010/mcp"


def print_table(rows: list[dict]):
    """Print a list of dicts as a formatted table."""
    if not rows:
        print("  (no data)")
        return

    # Pick columns and compute widths
    columns = list(rows[0].keys())
    widths = {col: len(col) for col in columns}
    for row in rows:
        for col in columns:
            widths[col] = max(widths[col], len(str(row.get(col, ""))))

    # Header
    header = " | ".join(col.ljust(widths[col]) for col in columns)
    separator = "-+-".join("-" * widths[col] for col in columns)
    print(f"  {header}")
    print(f"  {separator}")

    # Rows
    for row in rows:
        line = " | ".join(str(row.get(col, "")).ljust(widths[col]) for col in columns)
        print(f"  {line}")


async def main():
    async with streamablehttp_client(SERVER_URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            # List available tools
            result = await session.list_tools()
            tools = result.tools

            print(f"\nConnected to {SERVER_URL}")
            print(f"Found {len(tools)} tools\n")
            print("─" * 40)
            for tool in tools:
                print(f"  {tool.name}")
            print("─" * 40)

            # Call active_job_info with limit=5
            print("\nCalling active_job_info(limit=5)...\n")
            result = await session.call_tool("active_job_info", {"limit": 5})

            data = json.loads(result.content[0].text)
            if data.get("success") and data.get("data"):
                rows = data["data"]
                # Pick key columns for a readable table
                display_cols = [
                    "JOB_NAME_SHORT",
                    "AUTHORIZATION_NAME",
                    "SUBSYSTEM",
                    "JOB_STATUS",
                    "CPU_TIME",
                    "THREAD_COUNT",
                    "TEMPORARY_STORAGE",
                    "TOTAL_DISK_IO_COUNT",
                ]
                filtered = [
                    {col: row.get(col, "") for col in display_cols} for row in rows
                ]
                print(f"  {len(rows)} row(s) returned\n")
                print_table(filtered)
            else:
                print("  No data returned")


if __name__ == "__main__":
    asyncio.run(main())
