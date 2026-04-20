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

        print("\n=== YAML TOOLS ONLY (with toolsets annotation) ===")
        yaml_tools = [
            tool
            for tool in tools_list
            if tool.annotations and tool.annotations.toolsets
        ]
        for tool in yaml_tools:
            print(f"- {tool.name}: {tool.description}")
            print(f"  Toolsets: {tool.annotations.toolsets}")

        print("\n=== SECURITY TOOLS ONLY ===")
        security_tools = [
            tool
            for tool in tools_list
            if tool.annotations
            and tool.annotations.toolsets
            and "security" in tool.annotations.toolsets
        ]
        for tool in security_tools:
            print(f"- {tool.name}: {tool.description}")

        print("\n=== EXPOSED PROFILE TOOLS ===")
        profile_tools = [tool for tool in tools_list if "exposed" in tool.name.lower()]
        for tool in profile_tools:
            print(f"- {tool.name}: {tool.description}")

        # Get security tool names
        security_tool_names = [tool.name for tool in security_tools]

        print(
            f"\n=== AGENT CONFIGURED TO PREFER {len(security_tool_names)} SECURITY TOOLS ==="
        )
        for name in security_tool_names:
            print(f"- {name}")

        # Create agent with all tools but instruct it to prefer security tools
        agent = Agent(
            model=OpenAIChat(),
            tools=[tools],  # Use original tools but with specific instructions
            name="agno-agent",
            description=f"An agent that specializes in IBM i security analysis.",
            show_tool_calls=True,
            debug_mode=True,
            debug_level=2,
            markdown=True,
        )

        await agent.aprint_response(
            "what are the top 5 jobs consuming CPU?", stream=False
        )


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
