"""
Service Discovery Workflow

This workflow helps admins explore available IBM i services and understand
what's available on their system.

Use case: New admin learning about system capabilities or looking for
specific services to accomplish a task.

An IBM i admin runs this workflow to:
- Discover what service categories exist
- Understand the scope of available services
- Find services relevant to their task
"""

from agno.workflow import Workflow, Step
from agno.db.postgres import PostgresDb
from agents.ibmi_agents import get_sysadmin_discovery_agent
from db.session import db_url


# Create discovery agent with reasoning enabled
discovery_agent = get_sysadmin_discovery_agent(model="openai:gpt-4o", enable_reasoning=True, debug_mode=False)

# Define workflow step
service_discovery_step = Step(
    name="ServiceDiscovery", agent=discovery_agent, description="Discover and categorize available IBM i services"
)

# Create workflow
service_discovery_workflow = Workflow(
    name="IBM i Service Discovery",
    description="Explore and understand available IBM i services and capabilities",
    steps=[service_discovery_step],
    db=PostgresDb(id="agno-storage", db_url=db_url),
)


if __name__ == "__main__":
    import sys

    # Check if a topic was provided
    if len(sys.argv) > 1:
        topic = sys.argv[1]
        message = f"""
        Help me discover IBM i services related to "{topic}":

        1. List all service categories
        2. Identify which categories might relate to {topic}
        3. Show me the count of services by schema (QSYS2, SYSTOOLS, etc.)
        4. Provide a summary of what I can accomplish with these services

        Help me understand what's available and how I might use these services.
        """
    else:
        message = """
        Give me a comprehensive overview of IBM i services available on this system:

        1. List all service categories with their counts
        2. Show the distribution of services by schema
        3. Break down services by SQL object type (VIEW, PROCEDURE, FUNCTION, etc.)
        4. Provide insights on the breadth of capabilities available

        Help me understand the scope and organization of system services.
        """

    # Run the workflow
    service_discovery_workflow.print_response(
        message=message, markdown=True, stream=True, stream_intermediate_steps=True
    )
