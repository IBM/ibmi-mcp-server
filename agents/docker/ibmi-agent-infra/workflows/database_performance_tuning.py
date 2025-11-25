"""
Database Performance Tuning Workflow

This workflow focuses on database-specific performance analysis and optimization
for IBM i Db2 for i databases.

Use case: Database performance degradation, query optimization, index strategy review.

A database admin runs this workflow to:
- Analyze database-specific performance metrics
- Identify slow queries and resource-intensive operations
- Review index effectiveness and recommendations
- Generate database tuning recommendations

This workflow uses reasoning tools extensively for database optimization decisions.
"""

from textwrap import dedent
from agno.workflow import Workflow, Step
from agno.workflow.types import StepInput, StepOutput
from agno.db.postgres import PostgresDb
from agents.ibmi_agents import (
    get_performance_agent,
    get_sysadmin_discovery_agent,
    get_sysadmin_search_agent,
)
from db.session import db_url


# Create specialized agents
performance_agent = get_performance_agent(model="openai:gpt-4o", enable_reasoning=True)
discovery_agent = get_sysadmin_discovery_agent(model="openai:gpt-4o", enable_reasoning=True)
search_agent = get_sysadmin_search_agent(model="openai:gpt-4o", enable_reasoning=True)


# Step 1: Gather database performance metrics
db_metrics_step = Step(
    name="DatabaseMetrics",
    agent=performance_agent,
    description="Gather database-specific performance metrics and active job information",
)


# Step 2: Discover database optimization services
db_services_step = Step(
    name="DatabaseServices",
    agent=discovery_agent,
    description="Discover Db2 for i optimization and diagnostic services",
)


# Step 3: Search for database best practices
db_best_practices_step = Step(
    name="DatabaseBestPractices",
    agent=search_agent,
    description="Search for database performance and optimization services",
)


# Step 4: Custom analysis function
def database_performance_analysis(step_input: StepInput) -> StepOutput:
    """
    Synthesize database performance data and prepare optimization analysis.
    """
    metrics = step_input.get_step_content("DatabaseMetrics") or ""
    services = step_input.get_step_content("DatabaseServices") or ""
    best_practices = step_input.get_step_content("DatabaseBestPractices") or ""

    analysis_prompt = f"""
    Perform comprehensive database performance analysis:

    ## DATABASE METRICS:
    {metrics[:1200]}

    ## AVAILABLE DB2 SERVICES:
    {services[:800]}

    ## BEST PRACTICES GUIDANCE:
    {best_practices[:800]}

    ## DATABASE ANALYSIS TASKS:

    1. **Query Performance Analysis**:
       - Use think() to identify potential query performance issues
       - Analyze CPU consumption patterns for database operations
       - Identify resource-intensive database jobs
       - Evaluate query execution patterns

    2. **Resource Utilization**:
       - Database job resource consumption
       - Memory pool allocation for database work
       - I/O patterns and disk access efficiency
       - Lock contention indicators

    3. **Configuration Review**:
       - Database system values and settings
       - Memory pool configuration for database operations
       - Temporary storage usage for database work
       - Collection Services for database monitoring

    4. **Index Strategy Analysis**:
       - Use analyze() to evaluate potential index opportunities
       - Consider query access patterns
       - Balance index benefits vs. maintenance overhead
       - Identify missing or unused indexes

    5. **Optimization Opportunities**:
       - Query optimization recommendations
       - Index creation or modification suggestions
       - Configuration tuning opportunities
       - Resource allocation improvements

    Use reasoning tools to provide data-driven database optimization recommendations.
    """

    return StepOutput(step_name="DatabaseAnalysis", content=analysis_prompt, success=True)


analysis_preparation_step = Step(
    name="DatabaseAnalysis",
    executor=database_performance_analysis,
    description="Prepare comprehensive database performance analysis",
)


# Step 5: Execute analysis with reasoning
analysis_execution_step = Step(
    name="AnalysisExecution",
    agent=performance_agent,
    description="Execute database performance analysis with reasoning tools",
)


# Step 6: Generate tuning recommendations
tuning_recommendations_step = Step(
    name="TuningRecommendations",
    agent=performance_agent,
    description="Generate prioritized database tuning recommendations",
)


# Create workflow
database_tuning_workflow = Workflow(
    name="IBM i Database Performance Tuning",
    description="Comprehensive Db2 for i performance analysis and optimization workflow",
    steps=[
        db_metrics_step,
        db_services_step,
        db_best_practices_step,
        analysis_preparation_step,
        analysis_execution_step,
        tuning_recommendations_step,
    ],
    db=PostgresDb(id="agno-storage", db_url=db_url),
)


if __name__ == "__main__":
    database_tuning_workflow.print_response(
        message=dedent("""
            Perform comprehensive database performance tuning analysis for Db2 for i.

            DATABASE METRICS GATHERING:
            Focus on database-specific metrics:
            - Active database jobs and CPU consumption (use active_job_info with subsystem filter)
            - Overall system performance impacting database operations
            - Memory pool utilization for database work
            - Temporary storage usage for sorts and temporary tables
            - HTTP server if database is accessed via web services
            - System values affecting database performance

            DATABASE SERVICES DISCOVERY:
            Identify Db2 for i services for:
            - Query performance analysis
            - Index advisor capabilities
            - Database monitoring and diagnostics
            - SQL performance services
            - Lock and contention analysis

            DATABASE BEST PRACTICES:
            Search for services and documentation related to:
            - SQL query optimization
            - Index strategy
            - Database configuration
            - Performance monitoring
            - Database statistics

            TUNING RECOMMENDATIONS REQUIRED:

            1. **Query Optimization** (Immediate Actions):
               - Identify resource-intensive queries
               - Query rewrite recommendations
               - Execution plan improvements
               - Temp table usage optimization

            2. **Index Strategy** (High Priority):
               - Recommended new indexes with justification
               - Unused indexes to consider dropping
               - Index reorganization needs
               - Index maintenance strategy

            3. **Configuration Tuning** (Medium Priority):
               - Database system value recommendations
               - Memory pool optimization for database work
               - Temporary storage configuration
               - Query optimizer settings

            4. **Monitoring & Maintenance** (Ongoing):
               - Key performance indicators to track
               - Alerting thresholds for database metrics
               - Regular maintenance tasks
               - Statistics collection strategy
               - Performance trend monitoring

            5. **Capacity Planning**:
               - Database growth projections
               - Resource scaling recommendations
               - Archive and retention strategy
               - Performance baseline establishment

            For each recommendation:
            - Explain the performance impact (quantify if possible)
            - Provide implementation steps
            - Estimate complexity and duration
            - Note any risks or dependencies
            - Include validation/testing approach

            Use reasoning tools to provide defensible, data-driven recommendations.
        """),
        markdown=True,
        stream=True,
        stream_intermediate_steps=True,
    )
