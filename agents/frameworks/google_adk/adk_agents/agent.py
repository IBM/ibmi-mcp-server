from google.adk.agents.llm_agent import Agent
from google.adk.agents.callback_context import CallbackContext
from google.adk.apps.app import App
from google.adk.models.llm_response import LlmResponse
from google.adk.plugins import ReflectAndRetryToolPlugin
from google.adk.tools.tool_context import ToolContext
from google.adk.planners import PlanReActPlanner
from .sub_agents.performance_agent import performance_agent
from .sub_agents.sysadmin_discover import sysadmin_discover_agent
from .sub_agents.sysadmin_browse import sysadmin_browse_agent
from .sub_agents.sysadmin_search import sysadmin_search_agent

root_agent = Agent(
    model='gemini-2.5-flash',
    description='A helpful assistant for user questions.',
    name='coordinator_agent',
    instruction=""" ### Delegation Strategy

        1. **Understand Intent**
        - You have access to these four agents: performance_agent, sysadmin_search_agent, sysadmin_browse_agent, sysadmin_discover_agent
        - Parse the user’s query to determine if it’s about performance, system admin search, sys admin browse or sys admin discovery.
        - If uncertain, ask a clarifying question before delegating.

        2. **Route to Correct Agent**
        - **Performance:** CPU, jobs, memory, I/O, system utilization, or tuning.
        - **Discovery:** Listing or summarizing schemas, categories, or system organization.
        - **Browse:** Navigating or exploring libraries, schemas, or object hierarchies.
        - **Search:** Finding objects, services, or SQL examples by name or keyword.

        3. **Combine Agents When Needed**
        - Chain agents logically (Discovery → Browse → Search) for multi-step user goals.

        4. **Context Management**
        - Preserve relevant outputs from one agent when delegating to another.
        - Always mention which agent was used and why.

        5. **Response Format**
        - **Delegated Agent:** Explain routing choice.
        - **Agent Output Summary:** Summarize results clearly.
        - **Next Steps:** Suggest related insights or deeper queries.""",
    sub_agents=[performance_agent, sysadmin_search_agent, sysadmin_browse_agent, sysadmin_discover_agent],
    planner = PlanReActPlanner()
)

app = App(
    name="adk_agents",
    root_agent=root_agent,
    plugins=[
        ReflectAndRetryToolPlugin(max_retries=3),
    ],
)