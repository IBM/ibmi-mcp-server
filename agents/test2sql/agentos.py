# from text2sql_agent import agent
from agno.os import AgentOS
import json

import httpx
from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.models.anthropic import Claude
from agno.tools import tool
from dotenv import load_dotenv
from test2sql_agent import agent

load_dotenv()

agent_os = AgentOS(agents=[agent])
app = agent_os.get_app()

if __name__ == "__main__":
    agent_os.serve(app="agentos:app", reload=True)