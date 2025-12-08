from google.adk.agents.llm_agent import Agent
from google.adk.apps.app import App
from google.adk.plugins import ReflectAndRetryToolPlugin
from google.adk.planners import PlanReActPlanner
# from google.adk.tools import AgentTool
from google.genai import types
# from google.adk.a2a.utils.agent_to_a2a import to_a2a
from .sub_agents.performance_agent import get_performance_agent
from .sub_agents.sysadmin_discover import get_discover_agent
from .sub_agents.sysadmin_browse import get_browse_agent
from .sub_agents.sysadmin_search import get_search_agent
from .sub_agents.security_agent import get_security_agent
from .utils.utils import get_model
from .utils.prompts import COORDINATOR_INSTRUCTION

import warnings
warnings.filterwarnings("ignore")

performance_agent, _ = get_performance_agent(False)
discover_agent, _ = get_discover_agent(False) 
browse_agent, _ = get_browse_agent(False)
search_agent, _ = get_search_agent(False)
security_agent, _ = get_security_agent(False)

# Alternatively, use tools instead of sub_agents
# performance_tool = AgentTool(agent=performance_agent)
# sysadmin_discover_tool = AgentTool(agent=sysadmin_discover_agent)
# sysadmin_browse_tool = AgentTool(agent=sysadmin_browse_agent)
# sysadmin_search_tool = AgentTool(agent=sysadmin_search_agent)

root_agent = Agent(
    model=get_model(),
    description='A helpful assistant for user questions.',
    name='coordinator_agent',
    instruction= COORDINATOR_INSTRUCTION,
    sub_agents=[performance_agent, discover_agent, browse_agent, search_agent, security_agent],
    disallow_transfer_to_parent= True,
    planner = PlanReActPlanner(),
    generate_content_config=types.GenerateContentConfig(
        http_options=types.HttpOptions(
            retry_options=types.HttpRetryOptions(initial_delay=1, attempts=2),
        ),
    )
)

app = App(
    name="adk_agents",
    root_agent=root_agent,
    plugins=[
        ReflectAndRetryToolPlugin(max_retries=3),
    ],
)

# app = to_a2a(root_agent, host="localhost", port=8000, protocol="http")
