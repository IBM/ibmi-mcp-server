"""
Find Service Example Workflow

This workflow helps admins find and understand how to use specific IBM i services.

Use case: Admin knows what they want to do but needs to find the right
service and see usage examples.

An IBM i admin runs this workflow to:
- Search for services by name or keyword
- Get example usage code
- Understand service capabilities and requirements
"""

from agno.workflow import Workflow, Step
from agno.db.postgres import PostgresDb
from agents.ibmi_agents import get_sysadmin_search_agent
from db.session import db_url


# Create search agent with reasoning enabled
search_agent = get_sysadmin_search_agent(model="openai:gpt-4o", enable_reasoning=True, debug_mode=False)

# Define workflow step
service_search_step = Step(
    name="ServiceSearch", agent=search_agent, description="Search for IBM i services and retrieve usage examples"
)

# Create workflow
find_service_workflow = Workflow(
    name="IBM i Service Example Finder",
    description="Find and understand IBM i services with usage examples",
    steps=[service_search_step],
    db=PostgresDb(id="agno-storage", db_url=db_url),
)


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python find_service_example.py <search_term>")
        print("Example: python find_service_example.py ACTIVE_JOB")
        sys.exit(1)

    search_term = sys.argv[1]

    # Run the workflow
    find_service_workflow.print_response(
        message=f"""
        Help me find and understand services related to "{search_term}":

        1. Search for services with names matching "{search_term}"
        2. If found, get the service example code
        3. Explain what the service does and when to use it
        4. Show me the schema and object type information
        5. If multiple services match, help me understand the differences

        If no exact match, search for keywords in service examples that might be relevant.

        Provide clear, practical guidance on how to use these services.
        """,
        markdown=True,
        stream=True,
        stream_intermediate_steps=True,
    )
