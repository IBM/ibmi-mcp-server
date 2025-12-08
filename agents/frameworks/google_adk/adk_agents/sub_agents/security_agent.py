from google.adk.agents import Agent
from ..utils.utils import get_model
from ..utils.tools import get_security_tools
from ..utils.prompts import SECURITY_AGENT_PROMPT

def get_security_agent(debug_filtering: bool = False):
    security_toolset = get_security_tools(debug_filtering)

    security_ops_agent = Agent(
        model=get_model(),
        name='security_ops_agent',
        description="You help administrators identify security vulnerabilities and remediate security issues.",
        instruction= SECURITY_AGENT_PROMPT,
        tools=[security_toolset]
    )

    return security_ops_agent, security_toolset
