# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IBM i MCP Server monorepo — an npm workspaces repo that ships two published packages:

- **`@ibm/ibmi-mcp-server`** (`packages/server/`) — MCP server binary (`ibmi-mcp-server`). Production-grade MCP server enabling AI agents to interact with IBM i via Db2 for i. Uses Mapepire (WebSocket-based SQL gateway).
- **`@ibm/ibmi-cli`** (`packages/cli/`) — the `ibmi` command-line interface. Depends on `@ibm/ibmi-mcp-server` (exact-pinned) and calls its tool logic directly for fast local execution without MCP protocol overhead.

Both packages co-version: a single `v*` git tag releases both with the same version.

## Common Commands

All commands run from the repo root (npm workspaces handle the dispatch):

```bash
# Build
npm run build              # Compile TypeScript to dist/
npm run rebuild            # Clean and rebuild

# Test
npm test                   # Run all tests (Vitest)
npm run test:watch         # Watch mode
npm run test:coverage      # With coverage report

# Quality
npm run lint               # ESLint
npm run typecheck          # TypeScript type checking
npm run format             # Prettier formatting
npm run validate           # Validate YAML tool configurations

# Run
npm run start:http         # HTTP transport (port 3010, recommended for dev)
npm run start:stdio        # Stdio transport (for MCP Inspector)
npm run inspector          # Launch MCP Inspector UI

# YAML Tools
npm run list-toolsets                       # List available toolsets
npm run validate                            # Validate tool YAML files

# Release
npm run release:patch      # Patch version bump
npm run release:minor      # Minor version bump
```

### Run the server with npx

```bash
npx -y @ibm/ibmi-mcp-server@latest --transport http --tools /path/to/tools.yaml
```

## Architecture

### Core Pattern: "Logic Throws, Handler Catches"

Every tool follows strict two-file separation:

- **`logic.ts`** - Pure business logic. Throws `McpError` on failure. No try/catch for response formatting.
- **`registration.ts`** - Handler layer. Wraps logic in try/catch, formats responses via `ErrorHandler`.

```
packages/
├── server/                         # @ibm/ibmi-mcp-server
│   ├── src/
│   │   ├── index.ts                # MCP server entry (ibmi-mcp-server bin)
│   │   ├── public/                 # Barrel re-exports consumed by @ibm/ibmi-cli
│   │   │   ├── tools.ts            # executeSqlTool, generateSqlTool, *Logic fns
│   │   │   ├── services.ts         # IBMiConnectionPool, SourceManager, etc.
│   │   │   ├── context.ts          # requestContextService
│   │   │   └── formatting.ts       # tableFormatter
│   │   ├── mcp-server/             # McpServer init, transports
│   │   ├── ibmi-mcp-server/        # Tools, services, security
│   │   ├── utils/                  # telemetry, logger, formatting
│   │   └── types-global/           # McpError, JsonRpcErrorCode
│   └── tests/
└── cli/                            # @ibm/ibmi-cli
    ├── src/
    │   ├── index.ts                # CLI entry (ibmi bin)
    │   ├── commands/               # 13 commands
    │   ├── config/                 # ~/.ibmi/config.yaml loader
    │   ├── formatters/
    │   └── utils/
    └── tests/
```

CLI imports server internals via the `exports` subpath surface:
`@ibm/ibmi-mcp-server/tools`, `/services`, `/context`, `/formatting`.

### YAML-Driven SQL Tools

SQL tools are defined declaratively in `tools/*.yaml`:

```yaml
sources:
  ibmi-system:
    host: ${DB2i_HOST}
    user: ${DB2i_USER}
    password: ${DB2i_PASS}
    port: 8076

tools:
  tool_name:
    source: ibmi-system
    description: "LLM-facing description"
    statement: |
      SELECT ... FROM ... WHERE :param_name ...
    parameters:
      - name: param_name
        type: string
        required: true
        description: "Parameter description"
    annotations:
      readOnlyHint: true

toolsets:
  toolset_name:
    tools: [tool_name]
```

Load tools via `--tools ./tools/file.yaml` and select toolsets via `--toolsets toolset_name`.

### Key Services

- **SourceManager** (`services/SourceManager.ts`) - Mapepire connection pooling
- **SqlSecurityValidator** (`services/SqlSecurityValidator.ts`) - Enforces read-only queries by default
- **ToolProcessor** (`utils/ToolProcessor.ts`) - YAML tool hydration and registration

### Request Context & Logging

All operations use `RequestContext` for traceability:
```typescript
const context = requestContextService.createRequestContext({
  operation: "ToolExecution",
  toolName: "execute_sql",
});
logger.info("Executing query", context);
```

## Tool Development

### TypeScript Tools

Follow the echoTool pattern in `src/mcp-server/tools/echoTool/`:

1. **logic.ts**: Define Zod schemas, export logic function that throws on error
2. **registration.ts**: Register with server, wrap logic in try/catch
3. **index.ts**: Barrel export of registration function

### YAML SQL Tools

1. Add tool definition to appropriate `tools/*.yaml` file
2. Use parameter binding (`:param_name`) - never string interpolation
3. Include `FETCH FIRST N ROWS ONLY` for result limiting
4. Set `readOnlyHint: true` for SELECT queries
5. Run `npm run validate` to check syntax

## Testing

- Framework: Vitest
- Location: `packages/server/tests/` and `packages/cli/tests/` (each mirrors its `src/` structure)
- Prefer integration tests over mocked unit tests
- Use `@anatine/zod-mock` for test data generation

Run a single test file:
```bash
npm test -- tests/path/to/test.test.ts
```

## Environment Variables

Key variables (set in `.env` or environment):

| Variable | Description |
|----------|-------------|
| `DB2i_HOST` | IBM i hostname |
| `DB2i_USER` | Database user |
| `DB2i_PASS` | Database password |
| `MCP_TRANSPORT_TYPE` | `stdio` or `http` |
| `MCP_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |
| `IBMI_HTTP_AUTH_ENABLED` | Enable bearer token auth |

## Code Style

- Two-space indentation (Prettier enforced)
- camelCase for functions/variables
- PascalCase for classes/types
- SCREAMING_SNAKE_CASE for constants
- snake_case for tool names in YAML

## GitHub CLI

Always use `--repo IBM/ibmi-mcp-server` for all `gh` commands (issues, PRs, releases, etc.). The repo has multiple remotes and `gh` will fail without explicit repo targeting.

```bash
gh issue view 111 --repo IBM/ibmi-mcp-server
gh pr create --repo IBM/ibmi-mcp-server --head my-branch --base main --title "..."
```

## Git Commit Requirements

All commits MUST include a DCO sign-off. Always pass `-s` to `git commit`.

## Key Conventions

- Use Zod schemas for all input validation
- LLM-facing descriptions (in `.describe()`) must be clear and actionable
- Environment variables via `dotenv` - never hardcode credentials
- Structured logging with Pino - always include RequestContext
- Error responses use `McpError` with appropriate `JsonRpcErrorCode`

## Python Agents

Example agents in `agents/` and `client/` directories use Python with `uv`:

```bash
cd client
uv sync
uv run python agent.py
```

These are consumers of the MCP server, not part of the core TypeScript codebase.

## Workflow Preferences

### Branch & Worktree Strategy

Every plan that involves code changes should create a new branch using worktree support. This keeps the main working tree clean and allows parallel work streams:

- Use `EnterWorktree` to create an isolated worktree for each feature/refactor branch
- Name worktrees descriptively (e.g., `feat/pool-timeouts`, `fix/idle-leak`)
- Worktrees prevent accidental contamination between concurrent tasks

### Agent Teams

Use `TeamCreate` and agent teams for tasks with independent parallel workstreams. Prefer teams when:

- A task has 3+ independent subtasks that can execute concurrently
- Research, implementation, and verification can be split across agents
- Multiple files need changes that don't depend on each other

Match agent types to the work: `Explore` for research, `general-purpose` for implementation, `Plan` for architecture decisions. Keep the orchestrator focused on coordination and user communication.

## Related Documentation

- `AGENTS.md` - Repository guidelines and contribution flow
- `packages/server/README.md` - Comprehensive server documentation
- `packages/cli/README.md` - CLI usage guide
- `tools/README.md` - YAML tool configuration guide
