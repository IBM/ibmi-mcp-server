import asyncio
import os
import json
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


def format_result(result):
    # Extract and format the structured content
    if hasattr(result, "content") and result.content:
        content = result.content[0]
        if hasattr(content, "text"):
            data = json.loads(content.text)

            if data.get("success") and data.get("data"):
                print(
                    f"\n✓ Query executed successfully in {data['metadata']['executionTime']}ms"
                )
                print(f"  SQL: {data['metadata']['sqlStatement'].strip()}")
                print(f"\n  Results ({data['metadata']['rowCount']} row(s)):")
                print("  " + "-" * 76)

                for row in data["data"]:
                    for key, value in row.items():
                        print(f"  {key:30s}: {value}")
                print("  " + "-" * 76)
            else:
                print("\n❌ Query failed or returned no data")
                print(json.dumps(data, indent=2))
    else:
        print("\n⚠ Unexpected result format")
        print(
            json.dumps(
                result.model_dump() if hasattr(result, "model_dump") else result,
                indent=2,
                default=str,
            )
        )


async def main():
    # Connect to the IBM i MCP server with authentication
    async with streamablehttp_client("http://localhost:3010/mcp") as (
        read_stream,
        write_stream,
        _,
    ):
        # Create a session using the authenticated streams
        async with ClientSession(read_stream, write_stream) as session:
            # Initialize the connection
            await session.initialize()

            # List available tools (now authenticated with your IBM i credentials)
            tools = await session.list_tools()
            print("\n" + "=" * 80)
            print("AVAILABLE TOOLS")
            print("=" * 80)
            for i, tool in enumerate(tools.tools, 1):
                print(f"{i:2d}. {tool.name}")
                print(f"    └─ {tool.description}")

            # Execute a tool with authenticated IBM i access
            print("\n" + "=" * 80)
            print("SYSTEM ACTIVITY RESULT")
            print("=" * 80)
            result = await session.call_tool("system_activity", {})

            format_result(result)


if __name__ == "__main__":
    asyncio.run(main())
