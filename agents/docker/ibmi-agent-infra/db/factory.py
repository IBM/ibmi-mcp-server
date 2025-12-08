from typing import TYPE_CHECKING, Optional, Union
from agno.db.sqlite import SqliteDb
import os

from agno.db.postgres import PostgresDb    
from agno.knowledge.knowledge import Knowledge


def get_database(db_id: str = "agno-storage") -> Union["PostgresDb", SqliteDb]:
    """
    Get database instance based on environment configuration.

    Args:
        db_id: Database identifier

    Returns:
        PostgresDb for docker deployment, SqliteDb for CLI

    Environment Variables:
        USE_SQLITE: Set to "true" to use SQLite instead of PostgreSQL
    """
    use_sqlite = os.getenv("USE_SQLITE", "").lower() == "true"

    if use_sqlite:
        # Use SQLite for local CLI
        db_path = os.getenv("SQLITE_DB_PATH", "tmp/agents.db")
        return SqliteDb(id=db_id, db_file=db_path, memory_table="agent_memories", metrics_table="agent_metrics")
    else:
        # Use PostgreSQL for docker deployment
        # Import here to avoid errors when PostgreSQL is not available
        from agno.db.postgres import PostgresDb
        from db.session import db_url

        return PostgresDb(id=db_id, db_url=db_url)
