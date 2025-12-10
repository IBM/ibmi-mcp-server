from google.adk.agents import Agent
from ..utils.utils import get_model
from ..utils.tools import get_discovery_tools
from ..utils.prompts import DISCOVERY_AGENT_PROMPT

def get_discover_agent(debug_filtering: bool = False):
    discovery_toolset = get_discovery_tools(debug_filtering)
    
    sysadmin_discover_agent = Agent(
        model=get_model(),
        name='sysadmin_discover_agent',
        description="Discovers IBM i services, schemas, and system structure.",
        instruction = DISCOVERY_AGENT_PROMPT,
        tools=[discovery_toolset]
    )

    return sysadmin_discover_agent, discovery_toolset
