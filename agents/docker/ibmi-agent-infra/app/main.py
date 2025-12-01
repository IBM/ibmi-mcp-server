"""AgentOS Demo"""

import asyncio

from agno.os import AgentOS

from agents.agno_assist import get_agno_assist
from agents.ibmi_agents import get_performance_agent
from agents.web_agent import get_web_agent
from infra.config_manager import AgentConfigManager
from agents.ibmi_agents import (
    get_sysadmin_discovery_agent,
    get_sysadmin_browse_agent,
    get_sysadmin_search_agent,
)

# Initialize agent configuration manager
# Uses infra/config.yaml by default, or AGENT_CONFIG_PATH env var if set
# This single config file serves dual purpose:
#   - AgentOS reads: available_models, chat, etc. (AgentOSConfig fields)
#   - Our code reads: agents section (ExtendedAgentOSConfig)
agent_config_manager = AgentConfigManager()
print(f"✓ Agent configuration loaded from: {agent_config_manager.get_config_source()}")

# Create agents with configuration from config manager
web_agent = get_web_agent(model_id="gpt-4o")
agno_assist = get_agno_assist(model_id="gpt-4o")

# Create all IBM i agents using config manager
discovery_agent = get_sysadmin_discovery_agent(config_manager=agent_config_manager)
browse_agent = get_sysadmin_browse_agent(config_manager=agent_config_manager)
search_agent = get_sysadmin_search_agent(config_manager=agent_config_manager)
performance_agent = get_performance_agent(config_manager=agent_config_manager)

# Create the AgentOS
# Pass the config path as string so AgentOS can load it with its own AgentOSConfig schema
# This avoids validation errors from our extended config fields
agent_os = AgentOS(
    id="agentos-demo",
    agents=[
        web_agent,
        agno_assist,
        performance_agent,
        search_agent,
        browse_agent,
        discovery_agent,
    ],
    # Pass config path - AgentOS will load and validate with AgentOSConfig
    # It will use available_models, chat, etc. and ignore our custom 'agents' section
    config=str(agent_config_manager.config_path),
    enable_mcp_server=True,
)
app = agent_os.get_app()

if __name__ == "__main__":
    # Add knowledge to Agno Assist agent
    asyncio.run(
        agno_assist.knowledge.add_content_async(  # type: ignore
            name="Agno Docs",
            url="https://docs.agno.com/llms-full.txt",
        )
    )
    # Simple run to generate and record a session
    agent_os.serve(app="main:app", reload=True)
