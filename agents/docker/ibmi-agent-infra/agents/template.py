"""
Template for Creating New IBM i Agents

This template demonstrates the simplified pattern for creating IBM i agents
using AgentBuilder and AgentRunConfig.

To create a new agent:
1. Add your agent ID to agents/agent_ids.py
2. Copy this template and customize it
3. Import and register in agents/ibmi_agents.py if needed
4. Test with: python cli.py --agent your-agent-id

Example:
    # In agent_ids.py, add:
    class AgentID(str, Enum):
        ...
        YOUR_AGENT = "your-agent-id"

    # Then customize this template with your agent's details
"""

from textwrap import dedent

from agno.agent import Agent

from agents.agent_ids import AgentID
from agents.builder import AgentBuilder
from agents.config import AgentRunConfig
from agents.registry import register_agent, AgentMetadata


@register_agent(
    AgentMetadata(
        id="your-agent-id",  # Must match AgentID enum value
        name="Your Agent Name",
        description="Brief 1-2 sentence description of what your agent does",
        category="ibmi",
        tags=["tag1", "tag2", "tag3"],  # Optional tags for filtering
    )
)
def get_your_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    """
    Create your specialized IBM i agent.

    This agent does [describe what it does].

    Args:
        config: Agent runtime configuration (model, debug, tools, etc.)

    Returns:
        Configured Agent instance

    Examples:
        >>> # Basic usage with defaults
        >>> agent = get_your_agent()

        >>> # With custom model
        >>> config = AgentRunConfig(model="watsonx:llama-3-3-70b-instruct")
        >>> agent = get_your_agent(config)

        >>> # With reasoning disabled
        >>> config = AgentRunConfig(enable_reasoning=False)
        >>> agent = get_your_agent(config)
    """
    return (
        AgentBuilder(AgentID.YOUR_AGENT, "Your Agent Name")
        .with_description(dedent("""\
            You are a [specialized role] Assistant for IBM i systems.

            Your main capabilities include:
            - [Capability 1]
            - [Capability 2]
            - [Capability 3]

            You help administrators with [describe primary use case].
        """))
        .with_instructions(dedent("""\
            Your mission is to [describe mission]. Follow these steps:

            1. **[Phase 1 Name]**
            - [Task or guideline]
            - [Task or guideline]
            - [Task or guideline]

            2. **[Phase 2 Name]**
            - [Task or guideline]
            - [Task or guideline]
            - [Task or guideline]

            3. **[Phase 3 Name]**
            - [Task or guideline]
            - [Task or guideline]

            4. **Communication**
            - [Guideline for how to communicate with users]
            - [Guideline about response format]
            - [Guideline about clarity]

            Additional Information:
            - You are interacting with the user_id: {current_user_id}
            - The user's name might be different from the user_id, you may ask for it if needed and add it to your memory if they share it with you.
        """))
        # Specify MCP toolsets - these filter which tools are available
        # Common toolsets: "performance", "sysadmin_discovery", "sysadmin_browse", "sysadmin_search"
        .with_toolsets("your-toolset-name")
        # Optional: Add custom tools beyond MCP tools
        # .with_additional_tools(YourCustomTool())
        # Optional: Override default Agent() parameters
        # .with_agent_kwargs(num_history_runs=10, retries=5)
        .build(config)
    )


# Advanced Example: Agent with custom Agno tools and parameters
@register_agent(
    AgentMetadata(
        id="advanced-agent",
        name="Advanced Example Agent",
        description="Demonstrates advanced agent features",
        category="ibmi",
        tags=["advanced", "example"],
    )
)
def get_advanced_agent(config: AgentRunConfig = AgentRunConfig()) -> Agent:
    """
    Create an advanced agent with custom tools and parameters.

    This demonstrates:
    - Multiple MCP toolsets
    - Custom Agno tools
    - Overriding Agent() parameters
    """
    # Example custom tool (uncomment and customize if needed)
    # from your_tools import CustomDatabaseTool
    # custom_tool = CustomDatabaseTool()

    return (
        AgentBuilder(AgentID.ADVANCED_AGENT, "Advanced Agent")
        .with_description("An advanced agent with extra capabilities")
        .with_instructions("Follow advanced procedures...")
        .with_toolsets(
            "performance",  # Include performance monitoring tools
            "sysadmin_search",  # Include search tools
        )
        # Add custom tools beyond MCP tools
        # .with_additional_tools(custom_tool)
        # Override default Agent() parameters for special behavior
        .with_agent_kwargs(
            num_history_runs=10,  # Remember more conversation history
            num_history_sessions=5,  # Remember more previous sessions
            retries=5,  # More retry attempts on failures
        )
        .build(config)
    )


# Example: Testing your agent locally
if __name__ == "__main__":
    # Test with default config
    agent = get_your_agent()
    print(f"Created agent: {agent.name}")
    print(f"Agent ID: {agent.id}")
    print(f"Tools: {len(agent.tools)} tool(s)")

    # Test with custom config
    custom_config = AgentRunConfig(
        model="openai:gpt-4o",
        debug_mode=True,
        enable_reasoning=True,
    )
    custom_agent = get_your_agent(config=custom_config)
    print(f"\nCreated custom agent with debug_mode={custom_agent.debug_mode}")

    # Run interactively (uncomment to test)
    # agent.cli_app(markdown=True, stream=True)
