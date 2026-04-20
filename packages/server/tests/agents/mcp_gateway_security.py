from agno.agent import Agent
from agno.models.openai import OpenAIChat
from agno.models.anthropic import Claude
from agno.tools.mcp import MCPTools
from dotenv import load_dotenv
import os

load_dotenv(override=True)

env = {
    "MCP_AUTH_TOKEN": os.getenv("MCP_AUTH_TOKEN"),
    "MCP_SERVER_CATALOG_URLS": f"http://localhost:4444/servers/{os.getenv('MCP_SERVICE_ID')}",
    "MCP_TOOL_CALL_TIMEOUT": "120",
}


async def main():
    async with MCPTools(command="python -m mcpgateway.wrapper", env=env) as tools:
        # Print available tools for debugging
        result = await tools.session.list_tools()
        tools_list = result.tools  # Extract the tools list from the result

        print("=== ALL TOOLS ===")
        for tool in tools_list:
            print(f"- {tool.name}: {tool.description}")

        # Create agent with all tools but instruct it to prefer security tools
        agent = Agent(
            model=OpenAIChat(),
            tools=[tools],  # Use original tools but with specific instructions
            name="agno-agent",
            description=f"An agent that specializes in IBM i system analysis.",
            show_tool_calls=True,
            debug_mode=True,
            debug_level=2,
            markdown=True,
        )

        await agent.aprint_response(
            "what is my system status?", stream=False
        )


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
