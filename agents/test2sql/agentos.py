"""
AgentOS server for the IBM i Text-to-SQL Agent.

Provides a web-based interface for the Text-to-SQL agent using Agno's AgentOS.

Usage:
    python agentos.py
    # or
    uvicorn agentos:app --reload
"""

from agno.os import AgentOS
from dotenv import load_dotenv

from text2sql_agent import agent

load_dotenv()

agent_os = AgentOS(agents=[agent])
app = agent_os.get_app()

if __name__ == "__main__":
    agent_os.serve(app="agentos:app", reload=True)
