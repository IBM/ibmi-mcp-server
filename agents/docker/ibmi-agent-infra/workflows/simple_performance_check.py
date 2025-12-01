"""
Simple Performance Check Workflow

This workflow demonstrates a basic single-agent performance monitoring task.
Use case: Quick system health check during business hours.

An IBM i admin runs this workflow to:
- Get current system performance snapshot
- Identify any immediate performance concerns
- Receive quick recommendations if issues are found
"""

from agno.workflow import Workflow, Step
from agno.db.postgres import PostgresDb
from agents.ibmi_agents import get_performance_agent
from db.session import db_url


# Create performance agent with reasoning enabled
performance_agent = get_performance_agent(model="openai:gpt-4o", enable_reasoning=True, debug_mode=False)

# Define workflow step
health_check_step = Step(
    name="PerformanceHealthCheck",
    agent=performance_agent,
    description="Quick system health check with performance metrics analysis",
)

# Create workflow
simple_performance_workflow = Workflow(
    name="IBM i Quick Performance Check",
    description="Quick system health check for immediate performance concerns",
    steps=[health_check_step],
    db=PostgresDb(id="agno-storage", db_url=db_url),
)


if __name__ == "__main__":
    # Run the workflow with specific instructions
    simple_performance_workflow.print_response(
        message="""
        Perform a quick system health check:

        1. Check overall system status and activity
        2. Review CPU utilization patterns
        3. Check memory pool utilization
        4. Identify any immediate performance concerns
        5. Provide a brief summary with actionable recommendations if issues found

        Keep the response concise - this is a quick health check.
        """,
        markdown=True,
        stream=True,
        stream_intermediate_steps=True,
    )
