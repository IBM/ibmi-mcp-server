"""
System Health Audit Workflow

This workflow provides a comprehensive system health audit combining performance
monitoring, service discovery, and best practices validation.

Use case: Monthly health checks, pre/post-maintenance validation, compliance audits.

A DB admin or system admin runs this workflow to:
- Validate system configuration against best practices
- Identify potential reliability or performance issues
- Generate audit trail documentation
- Provide compliance-ready health reports

This workflow demonstrates conditional execution based on findings.
"""

from textwrap import dedent
from agno.workflow import Workflow, Step, Condition
from agno.workflow.types import StepInput
from agno.db.postgres import PostgresDb
from agents.ibmi_agents import (
    get_performance_agent,
    get_sysadmin_discovery_agent,
    get_sysadmin_browse_agent,
    get_sysadmin_search_agent,
)
from db.session import db_url


# Create agents
performance_agent = get_performance_agent(model="openai:gpt-4o", enable_reasoning=True)
discovery_agent = get_sysadmin_discovery_agent(model="openai:gpt-4o", enable_reasoning=True)
browse_agent = get_sysadmin_browse_agent(model="openai:gpt-4o", enable_reasoning=True)
search_agent = get_sysadmin_search_agent(model="openai:gpt-4o", enable_reasoning=True)


# Step 1: Initial Health Check
initial_health_step = Step(
    name="InitialHealthCheck", agent=performance_agent, description="Perform initial system health assessment"
)


# Condition evaluator: Check if deeper investigation is needed
def needs_deeper_investigation(step_input: StepInput) -> bool:
    """
    Evaluate if the initial health check indicates issues requiring deeper investigation.
    """
    health_content = step_input.previous_step_content or ""

    # Keywords indicating potential issues
    concern_indicators = [
        "warning",
        "high",
        "critical",
        "exceed",
        "bottleneck",
        "slow",
        "issue",
        "problem",
        "concern",
        "degradation",
        "utilization above",
        "approaching limit",
    ]

    # Check if any concern indicators are present
    has_concerns = any(indicator in health_content.lower() for indicator in concern_indicators)

    if has_concerns:
        print("\n⚠️  Issues detected - triggering deeper investigation")
    else:
        print("\n✅ System appears healthy - skipping deep investigation")

    return has_concerns


# Conditional deep investigation steps
service_analysis_step = Step(
    name="ServiceAnalysis", agent=discovery_agent, description="Analyze available diagnostic and monitoring services"
)

configuration_review_step = Step(
    name="ConfigurationReview",
    agent=browse_agent,
    description="Review system configuration and services related to issues found",
)

best_practices_check_step = Step(
    name="BestPracticesCheck",
    agent=search_agent,
    description="Search for best practices and solutions for identified issues",
)


# Final audit report generation
audit_report_step = Step(
    name="AuditReport",
    agent=performance_agent,
    description="Generate comprehensive audit report with findings and recommendations",
)


# Create workflow with conditional execution
system_health_audit_workflow = Workflow(
    name="IBM i System Health Audit",
    description="Comprehensive system health audit with conditional deep investigation",
    steps=[
        initial_health_step,
        Condition(
            name="DeepInvestigation",
            description="If issues found, perform deeper investigation",
            evaluator=needs_deeper_investigation,
            steps=[
                service_analysis_step,
                configuration_review_step,
                best_practices_check_step,
            ],
        ),
        audit_report_step,
    ],
    db=PostgresDb(id="agno-storage", db_url=db_url),
)


if __name__ == "__main__":
    system_health_audit_workflow.print_response(
        message=dedent("""
            Perform a comprehensive system health audit of our IBM i system.

            INITIAL HEALTH CHECK:
            Assess the following areas:
            1. **Performance Metrics**:
               - CPU utilization and trends
               - Memory pool health and pressure
               - I/O throughput and wait times
               - Active job resource consumption
               - HTTP server performance

            2. **Resource Availability**:
               - Temporary storage utilization
               - Storage headroom
               - Thread pool availability
               - Connection pool health

            3. **System Configuration**:
               - Key system values
               - Collection Services configuration
               - Memory pool allocation

            Identify any areas of concern requiring deeper investigation.

            IF ISSUES FOUND - DEEP INVESTIGATION:
            For any issues identified:
            - Discover diagnostic services relevant to the issue
            - Review configuration details for affected components
            - Search for IBM i best practices and solutions
            - Research similar issues and resolutions

            AUDIT REPORT DELIVERABLES:

            1. **Executive Summary**:
               - Overall health status (Healthy/Warning/Critical)
               - Number of issues by severity
               - Key findings summary
               - Required actions summary

            2. **Detailed Findings**:
               - Performance assessment results
               - Configuration compliance status
               - Identified issues with severity levels
               - Resource utilization analysis

            3. **Recommendations**:
               - Immediate actions required (Critical)
               - Short-term improvements (High Priority)
               - Optimization opportunities (Medium Priority)
               - Best practice implementations (Low Priority)

            4. **Compliance & Documentation**:
               - System configuration snapshot
               - Performance baselines
               - Audit trail for compliance
               - Monitoring recommendations

            Provide a professional, audit-ready report suitable for management review.
        """),
        markdown=True,
        stream=True,
        stream_intermediate_steps=True,
    )
