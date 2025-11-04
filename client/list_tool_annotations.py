from agno.tools.mcp import MCPTools
from dotenv import load_dotenv


load_dotenv(override=True)

url = "http://127.0.0.1:3010/mcp"


async def main():
    async with MCPTools(url=url, transport="streamable-http") as tools:
        # Print available tools for debugging
        result = await tools.session.list_tools()
        tools_list = result.tools  # Extract the tools list from the result
        toolsets = set()
        print("=== ALL TOOLS ===")
        for tool in tools_list:
            print(f"- {tool.name}: {tool.description}")
            print(f"  Annotations:{tool.annotations}")
            try:
                print(f"  Toolsets: {tool.annotations.toolsets}")
                toolsets.update(tool.annotations.toolsets)
            except AttributeError:
                print(f"  Toolsets: None")

        print(f"=== ALL TOOLSETS ===")
        for toolset in toolsets:
            print(f"- {toolset}")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())