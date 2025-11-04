from agno.tools.mcp import StreamableHTTPClientParams
from agno.agent import Agent
from agno.tools.mcp import MCPTools
from dotenv import load_dotenv
import argparse
import os
from utils import get_model

load_dotenv(override=True)

url = "http://127.0.0.1:3010/mcp"
server_params = StreamableHTTPClientParams(
    url=url,
    headers={"Authorization": f"Bearer {os.getenv('IBMI_MCP_ACCESS_TOKEN')}"}
)


async def main(prompt=None, dry_run=False, model_id="watsonx:meta-llama/llama-3-3-70b-instruct"):
    async with MCPTools(url=url, server_params=server_params, transport="streamable-http") as tools:
        # Print available tools for debugging
        result = await tools.session.list_tools()
        tools_list = result.tools  # Extract the tools list from the result

        # Create agent with all tools but instruct it to prefer security tools
        if not dry_run:
            agent = Agent(
                model=get_model(model_id),
                tools=[tools],  # Use original tools but with specific instructions
                name="agno-agent",
                description=f"An agent that specializes in IBM i performance analysis.",
                show_tool_calls=True,
                debug_mode=True,
                debug_level=1,
                markdown=True,
                additional_context={
                    "tool_annotations": {
                        tool.name: tool.annotations
                        for tool in tools_list
                        if tool.annotations
                    }
                },
            )

            # Use provided prompt or default prompt
            user_prompt = prompt if prompt else "what are the top 5 jobs consuming CPU?"

            await agent.aprint_response(user_prompt, stream=False)


if __name__ == "__main__":
    import asyncio

    # Parse command line arguments
    parser = argparse.ArgumentParser(
        description="IBM i MCP Agent Test - Query your IBM i system using natural language"
    )
    parser.add_argument("-p", "--prompt", type=str, help="Prompt to send to the agent")
    parser.add_argument(
        "-d",
        "--dry-run",
        action="store_true",
        help="Run in dry mode without executing actions",
    )
    
    parser.add_argument(
        "--model-id", 
        type=str,
        default="openai:gpt-4o",
        help="Model identifier in the format 'provider:model'. Supported providers: "
             "ollama (e.g., ollama:qwen2.5:latest), "
             "openai (e.g., openai:gpt-4o), "
             "anthropic (e.g., anthropic:claude-3-sonnet), "
             "watsonx (e.g., watsonx:granite-13b)"
    )

    args = parser.parse_args()

    asyncio.run(main(args.prompt, args.dry_run, args.model_id))

