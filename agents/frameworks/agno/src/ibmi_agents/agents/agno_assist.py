from textwrap import dedent
from typing import TYPE_CHECKING

from agno.agent import Agent
from agno.models.openai import OpenAIChat
from agno.tools.duckduckgo import DuckDuckGoTools

from .base_agent import get_shared_db

# Conditional imports for optional dependencies
if TYPE_CHECKING:
    from agno.knowledge import Knowledge
    from agno.knowledge.embedder.openai import OpenAIEmbedder
    from agno.vectordb.pgvector import PgVector, SearchType


def get_agno_assist(
    model_id: str = "gpt-4o",
    db_url: str | None = None,
    debug_mode: bool = False,
) -> Agent:
    """
    Create an Agno Assist agent for helping users learn about the Agno framework.

    Args:
        model_id: OpenAI model to use
        db_url: PostgreSQL database URL for knowledge storage (optional, uses SQLite if not provided)
        debug_mode: Enable debug logging

    Returns:
        Configured Agent instance
    """
    # Use PostgreSQL for knowledge if db_url provided, otherwise skip knowledge
    knowledge = None
    if db_url:
        try:
            from agno.knowledge import Knowledge
            from agno.knowledge.embedder.openai import OpenAIEmbedder
            from agno.vectordb.pgvector import PgVector, SearchType

            knowledge = Knowledge(
                contents_db=get_shared_db(),
                vector_db=PgVector(
                    db_url=db_url,
                    table_name="agno_assist_knowledge",
                    search_type=SearchType.hybrid,
                    embedder=OpenAIEmbedder(id="text-embedding-3-small"),
                ),
            )
        except ImportError:
            print(
                "⚠️  Warning: pgvector not installed. Knowledge base features disabled."
            )
            print("   Install with: pip install pgvector")

    return Agent(
        id="agno-assist",
        name="Agno Assist",
        model=OpenAIChat(id=model_id),
        # Tools available to the agent
        tools=[DuckDuckGoTools()],
        # Description of the agent
        description=dedent("""\
            You are AgnoAssist, an advanced AI Agent specializing in Agno: a lightweight framework for building multi-modal, reasoning Agents.

            Your goal is to help developers understand and use Agno by providing clear explanations, functional code examples, and best-practice guidance for using Agno.
        """),
        # Instructions for the agent
        instructions=dedent("""\
            Your mission is to provide comprehensive and actionable support for developers working with the Agno framework. Follow these steps to deliver high-quality assistance:

            1. **Understand the request**
            - Analyze the request to determine if it requires a knowledge search, creating an Agent, or both.
            - If you need to search the knowledge base, identify 1-3 key search terms related to Agno concepts.
            - If you need to create an Agent, search the knowledge base for relevant concepts and use the example code as a guide.
            - When the user asks for an Agent, they mean an Agno Agent.
            - All concepts are related to Agno, so you can search the knowledge base for relevant information

            After Analysis, always start the iterative search process. No need to wait for approval from the user.

            2. **Iterative Knowledge Base Search:**
            - Use the `search_knowledge_base` tool to iteratively gather information.
            - Focus on retrieving Agno concepts, illustrative code examples, and specific implementation details relevant to the user's request.
            - Continue searching until you have sufficient information to comprehensively address the query or have explored all relevant search terms.

            After the iterative search process, determine if you need to create an Agent.

            3. **Code Creation**
            - Create complete, working code examples that users can run. For example:
            ```python
            from agno.agent import Agent
            from agno.tools.duckduckgo import DuckDuckGoTools

            agent = Agent(tools=[DuckDuckGoTools()])

            # Perform a web search and capture the response
            response = agent.run("What's happening in France?")
            ```
            - Remember to:
                * Build the complete agent implementation
                * Includes all necessary imports and setup
                * Add comprehensive comments explaining the implementation
                * Ensure all dependencies are listed
                * Include error handling and best practices
                * Add type hints and documentation

            Key topics to cover:
            - Agent architecture, levels, and capabilities.
            - Knowledge base integration and memory management strategies.
            - Tool creation, integration, and usage.
            - Supported models and their configuration.
            - Common development patterns and best practices within Agno.

            Additional Information:
            - You are interacting with the user_id: {current_user_id}
            - The user's name might be different from the user_id, you may ask for it if needed and add it to your memory if they share it with you.\
        """),
        # -*- Knowledge -*-
        # Add the knowledge base to the agent if provided
        knowledge=knowledge,
        # Give the agent a tool to search the knowledge base (this is True by default but set here for clarity)
        search_knowledge=True if knowledge else False,
        # -*- Storage -*-
        # Storage chat history and session state in a SQLite database
        db=get_shared_db(),
        # -*- History -*-
        # Send the last 3 messages from the chat history
        add_history_to_context=True,
        num_history_runs=3,
        # Add a tool to read the chat history if needed
        read_chat_history=True,
        # -*- Memory -*-
        # Enable agentic memory where the Agent can personalize responses to the user
        enable_agentic_memory=True,
        # -*- Other settings -*-
        # Format responses using markdown
        markdown=True,
        # Add the current date and time to the instructions
        add_datetime_to_context=True,
        # Show debug logs
        debug_mode=debug_mode,
    )


# Create the agno assist agent instance for direct import
agno_assist = get_agno_assist()
