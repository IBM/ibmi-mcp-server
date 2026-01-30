"""
Performance Investigation Workflow

This complex workflow coordinates multiple agents to investigate and diagnose
performance issues on an IBM i system using Agno workflow conventions.

Use case: Users report slowness, admin needs to identify root cause and
provide recommendations.

Workflow steps:
1. Performance agent gathers comprehensive metrics
2. Discovery agent identifies relevant monitoring services
3. Performance agent performs deep analysis using reasoning
4. Generates detailed report with prioritized recommendations

An IBM i admin runs this workflow when:
- Users report system slowness
- Scheduled deep performance analysis is needed
- After system changes to verify no performance degradation
"""

from textwrap import dedent
from agno.workflow import Workflow, Step
from agno.workflow.types import StepInput, StepOutput
from agno.db.postgres import PostgresDb
from agents.ibmi_agents import (
    get_performance_agent,
    get_sysadmin_discovery_agent,
)
from db.session import db_url


# Create agents with reasoning enabled
performance_agent = get_performance_agent(model="openai:gpt-4o", enable_reasoning=True)

discovery_agent = get_sysadmin_discovery_agent(model="openai:gpt-4o", enable_reasoning=True)


# Step 1: Gather initial performance metrics
initial_metrics_step = Step(
    name="InitialMetrics",
    agent=performance_agent,
    description="Gather comprehensive performance metrics for investigation",
)

# Step 2: Identify relevant monitoring services
monitoring_services_step = Step(
    name="MonitoringServices",
    agent=discovery_agent,
    description="Identify additional monitoring services that might help with diagnosis",
)


# Step 3: Custom function for deep analysis that accesses previous steps
def deep_performance_analysis(step_input: StepInput) -> StepOutput:
    """
    Custom function that performs deep analysis using data from previous steps.
    """
    # Access specific step outputs
    metrics_data = step_input.get_step_content("InitialMetrics") or ""
    services_data = step_input.get_step_content("MonitoringServices") or ""

    # Create comprehensive analysis prompt
    analysis_prompt = f"""
    Perform deep performance analysis using all available data:

    ## INITIAL METRICS GATHERED:
    {metrics_data[:1000]}... [truncated for analysis focus]

    ## AVAILABLE MONITORING SERVICES:
    {services_data[:500]}... [truncated for analysis focus]

    ## YOUR DEEP ANALYSIS TASKS:

    1. **Pattern Analysis**:
       - Analyze CPU usage patterns vs. job activity
       - Examine memory pool utilization vs. thread counts
       - Identify I/O patterns and potential bottlenecks
       - Look for temporal trends in the metrics

    2. **Use Reasoning Tools**:
       - Use think() to structure your diagnostic approach
       - Use analyze() to examine metric relationships and correlations
       - Consider multiple hypotheses for root causes
       - Evaluate system architecture implications

    3. **Identify Specific Issues**:
       - Resource contentions
       - Configuration problems
       - Capacity limitations
       - Workload imbalances

    4. **Assess Severity and Impact**:
       - Critical issues requiring immediate action
       - Performance degradation affecting users
       - Efficiency improvements for optimization
       - Preventive measures for future issues

    Show your reasoning process for the diagnosis.
    """

    return StepOutput(step_name="DeepAnalysis", content=analysis_prompt, success=True)


deep_analysis_step = Step(
    name="DeepAnalysis",
    executor=deep_performance_analysis,
    description="Perform deep analysis using reasoning tools and all collected data",
)

# Step 4: Run the deep analysis with the performance agent
analysis_execution_step = Step(
    name="AnalysisExecution", agent=performance_agent, description="Execute the deep analysis plan with reasoning"
)


# Step 5: Generate prioritized recommendations
recommendations_step = Step(
    name="Recommendations",
    agent=performance_agent,
    description="Generate prioritized recommendations based on complete analysis",
)


# Create the complete workflow
performance_investigation_workflow = Workflow(
    name="IBM i Performance Investigation",
    description="Multi-step performance investigation with reasoning and prioritized recommendations",
    steps=[
        initial_metrics_step,
        monitoring_services_step,
        deep_analysis_step,  # Custom function that prepares analysis prompt
        analysis_execution_step,  # Agent executes the analysis
        recommendations_step,
    ],
    db=PostgresDb(id="agno-storage", db_url=db_url),
)


if __name__ == "__main__":
    # Run the complete investigation workflow
    performance_investigation_workflow.print_response(
        message=dedent("""
            We need to investigate system performance issues.

            CONTEXT:
            - Users are reporting system slowness
            - This is a comprehensive performance investigation
            - We need to identify root causes and provide actionable recommendations

            INITIAL METRICS TASK:
            Gather comprehensive performance metrics including:
            - Overall system status (CPU, memory, I/O)
            - System activity metrics
            - Memory pool utilization
            - HTTP server performance
            - Active job information for top CPU consumers
            - Temporary storage usage
            - System values affecting performance

            MONITORING SERVICES TASK:
            After metrics are gathered, identify:
            - Service categories related to performance monitoring
            - QSYS2 services for deeper performance analysis
            - Services that could help with root cause analysis
            - Job queue and process management services

            RECOMMENDATIONS TASK:
            Based on the complete analysis, provide:

            1. **Immediate Actions** (Critical - Do Now):
               - Issues causing active performance problems
               - Steps to stabilize the system
               - Estimated time and expected impact

            2. **Short-term Improvements** (High Priority - This Week):
               - Configuration optimizations
               - Resource reallocation recommendations
               - Implementation guidance

            3. **Long-term Optimizations** (Medium Priority - This Month):
               - Capacity planning recommendations
               - Architecture improvements
               - Best practice implementations

            4. **Preventive Measures**:
               - Early warning indicators to monitor
               - Alert thresholds to configure
               - Regular maintenance tasks

            For each recommendation explain WHY, WHAT, IMPACT, and RISKS.
        """),
        markdown=True,
        stream=True,
        stream_intermediate_steps=True,
    )
