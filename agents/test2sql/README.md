# IBM i Text-to-SQL Agent

A natural language to SQL agent for IBM i (Db2 for i) databases. Ask questions in plain English and get SQL queries executed automatically.

## Available Tools

| Tool | Description |
|------|-------------|
| `list_tables_in_schema` | List tables/views with row counts |
| `describe_sql_object` | Get DDL for tables, views, procedures |
| `validate_query` | Validate SQL syntax before execution |
| `execute_sql` | Execute SQL queries |
| `sample_rows` | Generate sample queries for exploration |
| `get_table_statistics` | Get comprehensive table stats |

## Prerequisites

- Python 3.13+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip
- Running IBM i MCP Server (see [server setup](../../server/README.md))
- Anthropic API key

## Quick Start

### 1. Start the IBM i MCP Server

Make sure the MCP server is running on `http://127.0.0.1:3010`:

```bash
cd ibmi-mcp-server/
IBMI_ENABLE_EXECUTE_SQL=true npx -y @ibm/ibmi-mcp-server@latest --transport http --tools tools/developer/text2sql.yaml
```

### 2. Set Up Environment

Create a `.env` file in this directory:

```bash
ANTHROPIC_API_KEY=your-api-key-here
```

### 3. Install Dependencies

```bash
# Using uv (recommended)
uv sync

# Or using pip
pip install -e .
```

### 4. Run the Agent

**Interactive Mode:**
```bash
uv run python cli.py
```

**Single Query Mode:**
```bash
uv run python cli.py -p "What tables are in the SAMPLE schema?"
```

## Example Queries

Try these prompts to explore your IBM i database:

```
Using the SAMPLE library, create a salary report for all departments showing headcount,
average salary, and total budget. Sort by average salary.
```

```
Who's working on projects MA2100, AD3100, and AD3110?
Show me their names, jobs, and departments grouped by project.
```

```
Give me a complete profile for employee 000010 including:
- Personal details and manager
- Current projects
- How their salary compares to department average
```

## How It Works

The agent follows a structured workflow:

1. **Schema Discovery** - Lists tables and examines metadata
2. **Query Planning** - Identifies needed tables and columns
3. **Query Validation** - Validates SQL syntax using IBM i's native parser
4. **Query Execution** - Runs the validated query
5. **Results** - Displays formatted results with insights


## AgentOS Interface (Optional)

Run the agent with a web UI using [AgentOS](https://os.agno.com/):

```bash
# Install server dependencies
uv sync --extra server

# Start the web server
uv run python agentos.py
```

Then open https://os.agno.com/ in your browser anf configure local endpoint `http://localhost:7777` to interact with your agent.

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key | Required |
| `MCP_SERVER_URL` | IBM i MCP server URL | `http://127.0.0.1:3010/mcp` |

## Troubleshooting

**"Connection refused" error:**
- Ensure the IBM i MCP server is running on port 3010
- Check that the server has valid IBM i credentials configured

**"Invalid API key" error:**
- Verify your `ANTHROPIC_API_KEY` in the `.env` file
- Make sure there are no extra spaces or quotes

**SQL validation fails:**
- The agent will show the error and suggest corrections
- Check that table/schema names are correct (IBM i uses uppercase)
