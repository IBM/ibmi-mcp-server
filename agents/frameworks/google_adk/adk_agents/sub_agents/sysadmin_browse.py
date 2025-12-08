from google.adk.agents import Agent
from ..utils.utils import get_model
from ..utils.tools import get_browse_tools
from ..utils.prompts import BROWSE_AGENT_PROMPT

def get_browse_agent(debug_filtering: bool = False):
    browse_toolset = get_browse_tools(debug_filtering)
    
    sysadmin_browse_agent = Agent(
        model= get_model(),
        name='sysadmin_browse_agent',
        description="Explores and navigates IBM i system objects and libraries.",
        instruction = BROWSE_AGENT_PROMPT,
        tools=[browse_toolset]
    )

    return sysadmin_browse_agent, browse_toolset
