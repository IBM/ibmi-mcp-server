from typing import Any, List
from agno.agent import Agent
from agno.models.base import Model
from agno.db.sqlite import SqliteDb

from .agent_ids import AgentID


# Shared database instance for all agents
_shared_db = None


def get_shared_db() -> SqliteDb:
    """
    Get or create the shared database instance for all agents.

    This ensures all agents use the same database instance with a consistent ID,
    preventing database ID conflicts in AgentOS.

    Returns:
        Shared SqliteDb instance
    """
    global _shared_db
    if _shared_db is None:
        _shared_db = SqliteDb(
            db_file="tmp/ibmi_agents.db",
            memory_table="agent_memory",
            session_table="agent_sessions",
            metrics_table="agent_metrics",
            eval_table="agent_evals",
            knowledge_table="agent_knowledge",
        )
    return _shared_db


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
        id: Unique identifier from AgentID enum
        name: Human-readable agent name
        model: Model instance
        description: Agent description for system prompt
        instructions: Detailed agent instructions
        tools: List of tools available to the agent
        debug_mode: Enable debug logging

    Returns:
        Configured Agent instance with shared IBM i agent settings
    """

    return Agent(
        id=str(id),
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
        # Storage chat history and session state in a SQLite database
        db=get_shared_db(),
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
