from google.adk.agents import Agent
from ..utils.utils import get_model
from ..utils.tools import get_performance_tools
from ..utils.prompts import PERFORMANCE_AGENT_PROMPT

def get_performance_agent(debug_filtering: bool = False):
    performance_toolset = get_performance_tools(debug_filtering)
    
    performance_agent = Agent(
        model=get_model(),
        name='performance_agent',
        description="Analyzes IBM i performance metrics and suggests optimizations.",
        instruction = PERFORMANCE_AGENT_PROMPT,
        tools=[performance_toolset]
    )

    return performance_agent, performance_toolset
