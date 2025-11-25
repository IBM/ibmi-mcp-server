"""
Capacity Planning Workflow

This workflow helps IBM i administrators assess current resource utilization
and plan for future capacity needs using trend analysis and reasoning.

Use case: Quarterly capacity reviews, growth planning, or pre-migration assessments.

An IBM i admin runs this workflow to:
- Analyze current resource utilization trends
- Identify capacity bottlenecks
- Project future resource needs
- Generate capacity planning recommendations

Workflow uses parallel data gathering followed by synthesis and planning.
"""

from textwrap import dedent
from agno.workflow import Workflow, Step, Parallel
from agno.workflow.types import StepInput, StepOutput
from agno.db.postgres import PostgresDb
from agents.ibmi_agents import (
    get_performance_agent,
    get_sysadmin_discovery_agent,
)
from db.session import db_url


# Create agents
performance_agent = get_performance_agent(model="openai:gpt-4o", enable_reasoning=True)

discovery_agent = get_sysadmin_discovery_agent(model="openai:gpt-4o", enable_reasoning=True)


# Define individual steps for parallel execution
current_utilization_step = Step(
    name="CurrentUtilization",
    agent=performance_agent,
    description="Gather current resource utilization across all system components",
)

service_inventory_step = Step(
    name="ServiceInventory", agent=discovery_agent, description="Inventory available monitoring and management services"
)


# Custom function to synthesize parallel results
def synthesize_capacity_data(step_input: StepInput) -> StepOutput:
    """
    Synthesize data from parallel capacity assessment steps.
    """
    # Get parallel step outputs (returns a dict for parallel steps)
    parallel_outputs = step_input.get_step_content("ParallelCapacityGathering") or {}

    utilization_data = parallel_outputs.get("CurrentUtilization", "")
    service_data = parallel_outputs.get("ServiceInventory", "")

    synthesis_prompt = f"""
    Synthesize capacity planning data from parallel assessments:

    ## CURRENT UTILIZATION DATA:
    {utilization_data[:1500]}

    ## AVAILABLE MONITORING SERVICES:
    {service_data[:800]}

    ## SYNTHESIS TASKS:

    1. **Identify Resource Patterns**:
       - Peak usage periods for CPU, memory, storage
       - Growth trends over time (if visible in data)
       - Resource headroom available
       - Bottlenecks or constraints

    2. **Use Reasoning for Capacity Analysis**:
       - Use think() to structure capacity assessment approach
       - Use analyze() to examine utilization patterns
       - Consider seasonal variations
       - Evaluate current vs. optimal capacity

    3. **Baseline Current State**:
       - Document current capacity metrics
       - Identify normal operating ranges
       - Note any anomalies or concerns
       - Establish baseline for future comparison

    Provide structured capacity assessment for planning.
    """

    return StepOutput(step_name="CapacitySynthesis", content=synthesis_prompt, success=True)


# Steps for workflow
parallel_gathering = Parallel(
    current_utilization_step,
    service_inventory_step,
    name="ParallelCapacityGathering",
    description="Gather utilization and service data in parallel",
)

synthesis_step = Step(
    name="CapacitySynthesis",
    executor=synthesize_capacity_data,
    description="Synthesize capacity data from parallel assessments",
)

analysis_step = Step(
    name="CapacityAnalysis", agent=performance_agent, description="Execute capacity analysis with reasoning"
)

planning_step = Step(
    name="CapacityPlanning", agent=performance_agent, description="Generate capacity planning recommendations"
)


# Create workflow
capacity_planning_workflow = Workflow(
    name="IBM i Capacity Planning",
    description="Comprehensive capacity assessment and planning with trend analysis",
    steps=[
        parallel_gathering,
        synthesis_step,
        analysis_step,
        planning_step,
    ],
    db=PostgresDb(id="agno-storage", db_url=db_url),
)


if __name__ == "__main__":
    capacity_planning_workflow.print_response(
        message=dedent("""
            Perform a comprehensive capacity planning assessment for our IBM i system.

            CURRENT UTILIZATION ANALYSIS:
            Gather current resource utilization including:
            - CPU utilization trends and peak usage
            - Memory pool allocation and usage patterns
            - Storage consumption and growth rates
            - Active job counts and resource consumption
            - HTTP server load and connection patterns
            - I/O throughput and bottlenecks

            SERVICE INVENTORY:
            Identify services available for:
            - Historical performance tracking
            - Resource trend analysis
            - Capacity monitoring
            - Growth projection

            CAPACITY PLANNING DELIVERABLES:

            1. **Current State Assessment**:
               - Baseline capacity metrics
               - Current utilization percentages
               - Headroom analysis (remaining capacity)
               - Resource constraint identification

            2. **Trend Analysis**:
               - Growth patterns observed
               - Peak vs. average utilization
               - Seasonal variations (if detectable)
               - Emerging bottlenecks

            3. **Future Projections** (6, 12, 24 months):
               - Projected resource needs based on trends
               - When capacity limits may be reached
               - Resource scaling requirements
               - Investment timeline recommendations

            4. **Recommendations**:
               - Immediate capacity actions needed
               - Short-term optimization opportunities
               - Long-term scaling strategy
               - Monitoring and alert thresholds
               - Budget planning guidance

            Use reasoning tools to provide data-driven, defensible projections.
        """),
        markdown=True,
        stream=True,
        stream_intermediate_steps=True,
    )
