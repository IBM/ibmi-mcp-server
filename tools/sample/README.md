# Employee Information Tools - Sample Toolset

This directory contains a complete sample toolset demonstrating IBM i MCP server capabilities with HR/employee data. Perfect for learning, testing, and showcasing the agent's abilities.

## 📁 Contents

- **`employee-info.yaml`** - Tool definitions for employee data access
- **`DEMO_PROMPTS.md`** - Comprehensive demo scenarios with detailed examples
- **`QUICK_START.md`** - Quick reference card for rapid testing
- **`../client/demo_employee_tools.py`** - Automated demo script

## 🎯 What's Included

### Tools (8 total)

| Tool | Purpose | Parameters | Complexity |
|------|---------|------------|------------|
| `get_employee_details` | Individual employee info with manager & dept | employee_id (string, 6 digits) | Simple |
| `find_employees_by_department` | List employees in a department | department_id (enum) | Simple |
| `find_employees_by_job` | Find employees by job title | job_title (enum) | Simple |
| `search_employees` | Search by name with pagination | name_search, page_size, page_number | Moderate |
| `get_employee_projects` | Projects for an employee | employee_id, include_completed (boolean) | Moderate |
| `get_department_salary_stats` | Dept salary analytics | department_id, min_salary, max_salary | Moderate |
| `find_project_team_members` | Team members on projects | project_ids (array) | Advanced |
| `calculate_employee_bonus` | Calculate bonus amount | employee_id, performance_multiplier (float) | Simple |

### Toolsets (3 logical groups)

1. **Employee Information** - Personal data, search, department/job queries
2. **Project Management** - Project assignments and team rosters
3. **Salary Analysis** - Compensation analytics and bonus calculations

## 🚀 Quick Start

### 1. Start the MCP Server

```bash
cd /path/to/ibmi-mcp-server

# Option A: Employee tools only
npx @ibm/ibmi-mcp-server@latest \
  --transport http \
  --tools ./tools/sample/employee-info.yaml

# Option B: With other toolsets too
npx @ibm/ibmi-mcp-server@latest \
  --transport http \
  --tools ./tools/sample/employee-info.yaml \
  --tools ./tools/performance/performance.yaml
```

### 2. Run the Agent

**Interactive Mode:**
```bash
cd client
python general_agent.py
```

**Automated Demo:**
```bash
cd client
python demo_employee_tools.py
```

### 3. Try a Prompt

```
Show me all analysts in the company with their salaries and departments
```

## 📚 Documentation

### For Quick Testing
👉 **[QUICK_START.md](./QUICK_START.md)** - Copy-paste prompts for rapid testing

Contains:
- One-line test commands
- 6 quick demo prompts (30 seconds - 3 minutes each)
- Debug checklist
- Pro tips

### For Comprehensive Examples
👉 **[DEMO_PROMPTS.md](./DEMO_PROMPTS.md)** - Detailed demo scenarios

Contains:
- 8 full demo scenarios with expected behavior
- Complex multi-tool workflows
- Visualization examples
- Edge case testing
- Sample agent sessions

## 🎓 Learning Path

**🟢 Beginner** (Start here!)
```
Show me all managers
```
```
List employees in department A00
```
```
Search for employees named John
```

**🟡 Intermediate**
```
Create a salary report for all departments showing headcount, average salary, and budget
```
```
Who's working on projects MA2100 and AD3100? Show their departments and time allocation.
```

**🟠 Advanced**
```
Give me a complete profile for employee 000010 including their projects and how their
salary compares to department average
```
```
Compare departments A00, B01, and C01 for employees earning $30k-$70k
```

**🔴 Expert**
```
Find analysts working on 2+ projects (potentially overallocated) and managers with
no current projects (underutilized). Provide recommendations for each.
```

## 🛠️ Use Cases Demonstrated

This toolset demonstrates:

✅ **Parameter Types**
- String with regex validation (`employee_id: ^[0-9]{6}$`)
- Enum constraints (`department_id`, `job_title`)
- Integer ranges (`salary: 0-100000`)
- Float ranges (`performance_multiplier: 0.0-0.3`)
- Boolean flags (`include_completed`)
- Array parameters (`project_ids: string[]`)
- Optional parameters with defaults
- Pagination parameters

✅ **Tool Chaining**
- Simple: Single tool to answer question
- Moderate: Sequential tool calls (list → detail)
- Advanced: Multiple tools with context sharing
- Expert: Complex workflows with branching logic

✅ **Data Operations**
- Filtering and searching
- Aggregation (COUNT, AVG, MIN, MAX, SUM)
- Joins across multiple tables
- Comparison and ranking
- Calculations (bonus = salary × multiplier)

✅ **Response Formatting**
- Tables and lists
- Executive summaries
- Text-based visualizations (charts, graphs)
- Professional reports
- Comparative analysis

✅ **Agent Capabilities**
- Natural language understanding
- Tool discovery and selection
- Parameter inference
- Multi-step reasoning
- Context retention
- Error handling
- Proactive insights

## 📊 Sample Data

These tools use IBM's standard SAMPLE database:

**Schemas:**
- `SAMPLE.EMPLOYEE` - ~50 employees
- `SAMPLE.DEPARTMENT` - 5 departments
- `SAMPLE.PROJECT` - Multiple projects
- `SAMPLE.EMPPROJACT` - Employee-project assignments

**Key Values:**
- **Departments**: A00, B01, C01, D01, E01
- **Job Titles**: PRES, MANAGER, ANALYST, DESIGNER, CLERK, SALESREP
- **Employee IDs**: 000010, 000020, 000030... (6-digit format)
- **Project IDs**: MA2100, AD3100, AD3110, IF1000...

## 🔍 Testing & Validation

### Automated Testing
```bash
cd client
python demo_employee_tools.py
```
Runs 7 scenarios automatically from simple to expert complexity.

### Manual Testing
Use prompts from `QUICK_START.md` or `DEMO_PROMPTS.md`

### Validation Checklist
- [ ] Single tool execution works
- [ ] Multi-tool chaining works
- [ ] Array parameters handled correctly
- [ ] Filtering (salary ranges) works
- [ ] Agent provides insights, not just data
- [ ] Error handling is graceful
- [ ] Context maintained across questions
- [ ] Visualizations are created when requested

## 💡 Extension Ideas

Want to customize or extend this toolset?

### Add New Tools
```yaml
tools:
  find_employees_by_salary:
    source: ibmi-sample
    description: Find employees within a salary range
    statement: |
      SELECT EMPNO, FIRSTNME, LASTNAME, SALARY
      FROM SAMPLE.EMPLOYEE
      WHERE SALARY BETWEEN :min_sal AND :max_sal
      ORDER BY SALARY DESC
    parameters:
      - name: min_sal
        type: integer
        required: true
      - name: max_sal
        type: integer
        required: true
```

### Create Custom Toolsets
Group related tools under different categories:
```yaml
toolsets:
  workforce_analytics:
    title: "Workforce Analytics"
    tools:
      - find_employees_by_salary
      - get_department_salary_stats
      - calculate_employee_bonus
```

### Add Write Operations
```yaml
tools:
  update_employee_salary:
    source: ibmi-sample
    description: Update an employee's salary (requires approval)
    statement: |
      UPDATE SAMPLE.EMPLOYEE
      SET SALARY = :new_salary
      WHERE EMPNO = :employee_id
    security:
      readOnly: false  # Mark as write operation
    annotations:
      destructiveHint: true  # Agent will require confirmation
```

## 🐛 Troubleshooting

### "No tools found"
```bash
# Verify server is loading tools
curl -X POST http://localhost:3010/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[] | .name'
```

### "No data returned"
```sql
-- Check SAMPLE database exists (on IBM i)
SELECT COUNT(*) FROM SAMPLE.EMPLOYEE;
```
If missing, create it using IBM's CRTSAMPLE command.

### "Agent doesn't understand my question"
- Try simpler phrasing
- Be more explicit about what you want
- Reference specific employee IDs or departments
- Check `DEMO_PROMPTS.md` for working examples

### "Wrong tool selected"
The agent uses tool descriptions to match intent. Ensure your question aligns with tool descriptions in `employee-info.yaml`.

## 📖 Related Documentation

- **[Main README](../../README.md)** - Project overview
- **[Tools Guide](../README.md)** - Creating custom tools
- **[Agent Guide](../../agents/README.md)** - Agent frameworks
- **[Client README](../../client/README.md)** - Python clients

## 🤝 Contributing

Have ideas for new demo prompts? Better visualizations? Additional tools?

Feel free to:
1. Add prompts to `DEMO_PROMPTS.md`
2. Create new tools in `employee-info.yaml`
3. Enhance the demo script
4. Share interesting agent interactions

## 📝 License

Apache 2.0 - See [LICENSE](../../LICENSE)

---

**Ready to start?** → Begin with [QUICK_START.md](./QUICK_START.md)

**Want details?** → Check out [DEMO_PROMPTS.md](./DEMO_PROMPTS.md)

**Prefer automation?** → Run `python client/demo_employee_tools.py`
