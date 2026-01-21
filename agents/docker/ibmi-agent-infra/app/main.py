"""AgentOS Demo"""

import asyncio

from agno.os import AgentOS
from agents.ibmi_agents import get_performance_agent
from infra.config_manager import AgentConfigManager
from agents.ibmi_agents import (
    get_sysadmin_discovery_agent,
    get_sysadmin_browse_agent,
    get_sysadmin_search_agent,
)
from fastapi.middleware.cors import CORSMiddleware

# Initialize agent configuration manager
# Uses infra/config.yaml by default, or AGENT_CONFIG_PATH env var if set
# This single config file serves dual purpose:
#   - AgentOS reads: available_models, chat, etc. (AgentOSConfig fields)
#   - Our code reads: agents section (ExtendedAgentOSConfig)
agent_config_manager = AgentConfigManager()
print(f"✓ Agent configuration loaded from: {agent_config_manager.get_config_source()}")

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

origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if __name__ == "__main__":
    # Simple run to generate and record a session
    agent_os.serve(app="main:app", reload=True)
