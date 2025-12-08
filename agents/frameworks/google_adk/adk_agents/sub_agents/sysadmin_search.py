from google.adk.agents import Agent
from ..utils.utils import get_model
from ..utils.tools import get_search_tools
from ..utils.prompts import SEARCH_AGENT_PROMPT

def get_search_agent(debug_filtering: bool = False):
    search_toolset = get_search_tools(debug_filtering)
    
    sysadmin_search_agent = Agent(
        model=get_model(),
        name='sysadmin_search_agent',
        description="Searches for specific IBM i objects and provides quick lookups.",
        instruction = SEARCH_AGENT_PROMPT,
        tools=[search_toolset],
    )

    return sysadmin_search_agent, search_toolset
