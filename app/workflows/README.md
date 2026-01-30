# IBM i Agent Workflows

This directory contains Agno-based workflow examples for IBM i system administration and database administration tasks. All workflows follow Agno workflow conventions and use the specialized IBM i agents with reasoning capabilities.

## Overview

Workflows coordinate multiple agents to accomplish complex multi-step operations. They demonstrate:
- Sequential step execution
- Parallel data gathering
- Conditional execution based on findings
- Custom executor functions for data synthesis
- Reasoning tools for complex analysis
- Structured data flow between steps

## Workflow Categories

### Simple Workflows (Single Agent)

These workflows demonstrate basic single-agent tasks, ideal for learning or quick operations.

#### `simple_performance_check.py`
**Use Case:** Quick system health check during business hours

**What it does:**
- Performs rapid system performance assessment
- Checks CPU, memory, and I/O metrics
- Identifies immediate concerns
- Provides concise recommendations

**Run:**
```bash
python workflows/simple_performance_check.py
```

#### `service_discovery.py`
**Use Case:** New admin learning about system capabilities

**What it does:**
- Discovers available IBM i service categories
- Shows service distribution by schema (QSYS2, SYSTOOLS, etc.)
- Provides overview of system capabilities
- Can focus on specific topics (e.g., "performance", "security")

**Run:**
```bash
python workflows/service_discovery.py                    # Full discovery
python workflows/service_discovery.py performance        # Topic-focused
```

#### `find_service_example.py`
**Use Case:** Finding specific services and usage examples

**What it does:**
- Searches for services by name or keyword
- Retrieves service example code
- Explains service capabilities and requirements
- Shows schema and object type information

**Run:**
```bash
python workflows/find_service_example.py ACTIVE_JOB
python workflows/find_service_example.py MEMORY
```

---

### Complex Workflows (Multi-Agent)

These workflows coordinate multiple agents for comprehensive analysis and recommendations.

#### `performance_investigation.py`
**Use Case:** Investigating reported system slowness

**Agents Used:**
- Performance Agent (metrics, analysis, recommendations)
- Discovery Agent (monitoring services)

**Workflow Steps:**
1. **InitialMetrics**: Gather comprehensive performance metrics
2. **MonitoringServices**: Identify relevant monitoring services
3. **DeepAnalysis**: Custom function synthesizing data from steps 1-2
4. **AnalysisExecution**: Execute deep analysis with reasoning
5. **Recommendations**: Generate prioritized recommendations (Immediate/Short-term/Long-term/Preventive)

**Key Features:**
- Uses custom executor function to access multiple previous steps
- Employs reasoning tools (think, analyze) for diagnostics
- Provides prioritized recommendations with WHY, WHAT, IMPACT, RISKS

**Run:**
```bash
python workflows/performance_investigation.py
```

**Output Includes:**
- Root cause analysis with reasoning shown
- Immediate actions (critical)
- Short-term improvements (high priority)
- Long-term optimizations (medium priority)
- Preventive measures and monitoring recommendations

---

#### `capacity_planning_workflow.py`
**Use Case:** Quarterly capacity reviews, growth planning, pre-migration assessments

**Agents Used:**
- Performance Agent (utilization analysis, projections)
- Discovery Agent (monitoring services)

**Workflow Steps:**
1. **ParallelCapacityGathering**: Parallel execution of:
   - CurrentUtilization (resource metrics)
   - ServiceInventory (monitoring capabilities)
2. **CapacitySynthesis**: Custom function synthesizing parallel results
3. **CapacityAnalysis**: Pattern analysis with reasoning
4. **CapacityPlanning**: Generate capacity projections and recommendations

**Key Features:**
- Parallel data gathering for efficiency
- Trend analysis and growth projections
- 6/12/24 month capacity forecasts
- Resource headroom analysis

**Run:**
```bash
python workflows/capacity_planning_workflow.py
```

**Output Includes:**
- Current state baseline
- Trend analysis and patterns
- Future projections (6, 12, 24 months)
- Scaling recommendations with timeline
- Budget planning guidance

---

#### `system_health_audit.py`
**Use Case:** Monthly health checks, compliance audits, pre/post-maintenance validation

**Agents Used:**
- Performance Agent (health check, audit report)
- Discovery Agent (service analysis)
- Browse Agent (configuration review)
- Search Agent (best practices)

**Workflow Steps:**
1. **InitialHealthCheck**: Initial system health assessment
2. **DeepInvestigation** (Conditional - triggered if issues found):
   - ServiceAnalysis: Diagnostic services relevant to issues
   - ConfigurationReview: Configuration details for affected components
   - BestPracticesCheck: Search for solutions and best practices
3. **AuditReport**: Comprehensive audit documentation

**Key Features:**
- Conditional execution based on health check results
- Multi-agent coordination for investigation
- Audit-ready documentation
- Compliance-focused reporting

**Run:**
```bash
python workflows/system_health_audit.py
```

**Output Includes:**
- Executive summary with health status
- Detailed findings by area
- Prioritized recommendations
- Compliance documentation and audit trail

---

#### `database_performance_tuning.py`
**Use Case:** Database performance degradation, query optimization, index strategy review

**Agents Used:**
- Performance Agent (DB metrics, analysis, tuning)
- Discovery Agent (Db2 services)
- Search Agent (DB best practices)

**Workflow Steps:**
1. **DatabaseMetrics**: Gather database-specific performance data
2. **DatabaseServices**: Discover Db2 for i optimization services
3. **DatabaseBestPractices**: Search for DB optimization guidance
4. **DatabaseAnalysis**: Custom function synthesizing DB data
5. **AnalysisExecution**: Execute DB analysis with reasoning
6. **TuningRecommendations**: Generate database tuning plan

**Key Features:**
- Database-specific focus (queries, indexes, config)
- Index strategy analysis and recommendations
- Query optimization guidance
- Configuration tuning for database workloads

**Run:**
```bash
python workflows/database_performance_tuning.py
```

**Output Includes:**
- Query optimization recommendations
- Index strategy (create/drop/reorganize)
- Configuration tuning for database work
- Monitoring and maintenance strategy
- Capacity planning for database growth

---

## Workflow Patterns Demonstrated

### Sequential Execution
Standard pattern where each step runs after the previous completes:
```python
Workflow(
    steps=[step1, step2, step3]
)
```

### Parallel Execution
Multiple steps run simultaneously for efficiency:
```python
Parallel(
    step_a,
    step_b,
    name="ParallelGathering"
)
```

### Conditional Execution
Steps execute only if condition is met:
```python
Condition(
    name="DeepDive",
    evaluator=needs_investigation_func,
    steps=[investigation_step1, investigation_step2]
)
```

### Custom Executor Functions
Access data from multiple previous steps:
```python
def custom_analysis(step_input: StepInput) -> StepOutput:
    # Access specific steps
    data1 = step_input.get_step_content("StepName1")
    data2 = step_input.get_step_content("StepName2")

    # Or access all previous content
    all_data = step_input.get_all_previous_content()

    # Process and return
    return StepOutput(
        step_name="CustomAnalysis",
        content=processed_data,
        success=True
    )
```

### Accessing Parallel Step Outputs
When a parallel step completes, its output is a dictionary:
```python
parallel_outputs = step_input.get_step_content("ParallelStepName")
# Returns: {"SubStep1": "output1", "SubStep2": "output2"}
```

## Reasoning Tools Integration

All agents are configured with `ReasoningTools(add_instructions=True)` which provides:

- **`think()`**: Structure analytical approach
- **`analyze()`**: Examine patterns and correlations
- **`evaluate()`**: Assess multiple options
- **`reflect()`**: Review and improve reasoning

Workflows leverage these tools for:
- Complex diagnostics (performance investigation)
- Multi-factor decision making (capacity planning)
- Pattern recognition (trend analysis)
- Root cause analysis (troubleshooting)

## Database Configuration

All workflows use PostgreSQL for session storage:
```python
db=PostgresDb(id="agno-storage", db_url=db_url),
```

The `db_url` is imported from `db.session` and configured via environment variables.

This enables:
- Persistent conversation history
- Session resumption across restarts
- Audit trails and compliance tracking
- Multi-user support with proper isolation
- Production-ready storage backend

## Running Workflows

All workflows support:
- **Streaming output**: Real-time results as agents work
- **Intermediate steps**: See progress through multi-step workflows
- **Markdown formatting**: Clean, readable output

Standard execution pattern:
```python
workflow.print_response(
    message="workflow instructions",
    markdown=True,
    stream=True,
    stream_intermediate_steps=True
)
```

## Extending Workflows

To create new workflows:

1. **Import required components:**
```python
from agno.workflow import Workflow, Step, Parallel, Condition
from agno.workflow.types import StepInput, StepOutput
from agno.db.postgres import PostgresDb
from agents.ibmi_agents import get_performance_agent, ...
from db.session import db_url
```

2. **Create agents with reasoning:**
```python
agent = get_performance_agent(
    model="openai:gpt-4o",
    enable_reasoning=True
)
```

3. **Define steps:**
```python
step = Step(
    name="UniqueStepName",
    agent=agent,
    description="What this step does"
)
```

4. **Create workflow:**
```python
workflow = Workflow(
    name="Workflow Name",
    description="What it accomplishes",
    steps=[step1, step2, ...],
    db=PostgresDb(id="agno-storage", db_url=db_url),
)
```

5. **Execute:**
```python
workflow.print_response(message="instructions", ...)
```

## Use Case Reference

### For System Administrators:
- **Daily**: `simple_performance_check.py` - Quick health checks
- **As Needed**: `find_service_example.py` - Learn new services
- **Weekly**: `service_discovery.py` - Explore capabilities
- **Monthly**: `system_health_audit.py` - Compliance audits
- **When Issues Arise**: `performance_investigation.py` - Root cause analysis
- **Quarterly**: `capacity_planning_workflow.py` - Growth planning

### For Database Administrators:
- **When Performance Degrades**: `database_performance_tuning.py`
- **Monthly**: `system_health_audit.py` - DB health validation
- **Quarterly**: `capacity_planning_workflow.py` - DB capacity planning
- **After Schema Changes**: `database_performance_tuning.py` - Index optimization

## Best Practices

1. **Use reasoning-enabled agents** for complex analysis workflows
2. **Parallel execution** for independent data gathering steps
3. **Conditional execution** to optimize workflow paths
4. **Custom executors** when you need to synthesize multiple data sources
5. **Descriptive step names** for clear workflow tracking
6. **Stream intermediate steps** for long-running workflows
7. **Store sessions** for audit trails and resumption

## Troubleshooting

**Issue**: Workflow fails at a specific step
- Check agent configuration and tool availability
- Verify MCP server is running and accessible
- Review step descriptions and agent instructions

**Issue**: Reasoning tools not working
- Ensure `enable_reasoning=True` in agent creation
- Verify ReasoningTools are in the agent's tools list
- Check model supports function calling

**Issue**: Parallel steps not working
- Ensure parallel steps are truly independent
- Check that each step has unique names
- Verify agent configurations are correct

**Issue**: Custom executor errors
- Validate StepInput access patterns
- Ensure StepOutput has required fields
- Check step names match exactly (case-sensitive)

## Contributing

When adding new workflows:
1. Follow Agno workflow conventions
2. Use reasoning tools for complex decisions
3. Add comprehensive documentation
4. Include use case description
5. Document expected outputs
6. Update this README

## Resources

- [Agno Workflows Documentation](https://docs.agno.com/concepts/workflows/overview)
- [Agno Reasoning Tools](https://docs.agno.com/concepts/reasoning/reasoning-tools)
- [IBM i Services Documentation](https://www.ibm.com/docs/en/i)
- [Db2 for i Performance](https://www.ibm.com/docs/en/i/7.5?topic=performance)
