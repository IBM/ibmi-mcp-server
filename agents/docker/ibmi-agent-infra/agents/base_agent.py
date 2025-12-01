from typing import Any, List
from agno.agent import Agent
from agno.models.base import Model
from agno.db.postgres import PostgresDb
from agents.agent_ids import AgentID
from db.session import db_url


def create_ibmi_agent(
    id: AgentID,
    name: str,
    model: Model,
    description: str,
    instructions: str,
    tools: List[Any] = None,
    debug_mode: bool = False,
) -> Agent:
    """
    Internal factory for creating IBM i agents with shared configuration.

    This function centralizes all common Agent settings (database, history,
    memory, formatting) while allowing agent-specific customization through
    the parameters.

    Args:
        agent_id: Unique identifier from AgentID enum
        name: Human-readable agent name
        model: Model instance (already processed by get_model())
        description: Agent description for system prompt
        instructions: Detailed agent instructions
        tools: List of tools available to the agent
        debug_mode: Enable debug logging

    Returns:
        Configured Agent instance with shared IBM i agent settings
    """

    return Agent(
        id=id,
        name=name,
        model=model,
        description=description,
        instructions=instructions,
        tools=tools,
        debug_mode=debug_mode,
        # -*- Default Settings -*-
        markdown=True,
        add_datetime_to_context=True,
        # -*- Storage -*-
        # Storage chat history and session state in a Postgres table
        db=PostgresDb(id="agno-storage", db_url=db_url),
        # --- Session settings ---
        search_session_history=True,
        num_history_sessions=2,
        # --- Agent History ---
        add_history_to_context=True,
        num_history_runs=3,
        # num_history_messages=2,
        # --- Default tools ---
        # Add a tool to read the chat history if needed
        read_chat_history=True,
        read_tool_call_history=True,
        # --- Agent Response Settings ---
        retries=3,
        # -*- Memory -*-
        # Enable agentic memory where the Agent can personalize responses to the user
        enable_agentic_memory=True,
    )
