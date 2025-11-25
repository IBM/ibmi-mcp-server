import asyncio

from agno.agent import Agent
from agno.models.openai import OpenAIChat
from agno.tools.mcp import MCPTools

# This is the URL of the MCP server we want to use.
server_url = "http://localhost:8000/mcp"


async def run_agent(message: str) -> None:
    async with MCPTools(transport="streamable-http", url=server_url) as mcp_tools:
        agent = Agent(
            model=OpenAIChat(id="gpt-4o"),
            tools=[mcp_tools],
            markdown=True,
            debug_mode=True,
        )
        await agent.aprint_response(input=message, stream=True, markdown=True)


# Example usage
if __name__ == "__main__":
    asyncio.run(run_agent("Which agents do I have in my AgentOS?"))
