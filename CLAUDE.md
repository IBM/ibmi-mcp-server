# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IBM i MCP Server - A production-grade Model Context Protocol server enabling AI agents to interact with IBM i systems via Db2 for i databases. Uses Mapepire (WebSocket-based SQL gateway) for database connectivity.

## Common Commands

All commands run from the `server/` directory (or root, which delegates to server):

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
npm run list-toolsets -- --tools ../tools   # List available toolsets
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
server/src/
├── index.ts                    # CLI entry point
├── mcp-server/
│   ├── server.ts              # McpServer initialization
│   ├── tools/utils/           # Tool factory and utilities
│   └── transports/            # Stdio, HTTP transports
├── ibmi-mcp-server/
│   ├── tools/                 # IBM i tools (executeSql, generateSql)
│   ├── services/              # SourceManager, SqlSecurityValidator
│   └── utils/                 # Tool processors, config
├── utils/
│   ├── telemetry/            # OpenTelemetry instrumentation
│   └── internal/             # Logger, RequestContext
└── types-global/             # McpError, JsonRpcErrorCode
```

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
- Location: `server/tests/` (mirrors src/ structure)
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

## Related Documentation

- `AGENTS.md` - Repository guidelines and contribution flow
- `server/README.md` - Comprehensive server documentation
- `tools/README.md` - YAML tool configuration guide
