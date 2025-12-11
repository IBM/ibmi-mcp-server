import asyncio
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

server_config = Path(__file__).parent.parent / ".env"
if not server_config.exists():
    print(f"server config does not exist, make sure to set up server .env file")
    sys.exit(1)

server = StdioServerParameters(
    command="npx",
    args=["ibmi-mcp-server", "--transport", "stdio"],
    env={
        "MCP_SERVER_CONFIG": str(server_config),
        "TOOLS_YAML_PATH": str(Path(__file__).parent.parent / "tools"),
    },
)


async def main():
    async with stdio_client(server=server) as (read, write):
        async with ClientSession(read_stream=read, write_stream=write) as session:
            await session.initialize()

            tools = await session.list_tools()
            for i, tool in enumerate(tools.tools):
                print(f"{i:2d}. {tool.name}")
                print(f"    └─ {tool.description}")


if __name__ == "__main__":
    asyncio.run(main())
