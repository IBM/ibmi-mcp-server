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
npm run validate -- --tools-dir tools   # Validate YAML tool configurations

# Run
npm run start:http         # HTTP transport (port 3010, recommended for dev)
npm run start:stdio        # Stdio transport (for MCP Inspector)
npm run inspector          # Launch MCP Inspector UI (needs an mcp.json at the repo root; see packages/server/README.md "MCP Inspector")

# YAML Tools
npm run list-toolsets                       # List available toolsets (needs YAML_ALLOW_DUPLICATE_SOURCES=true)
npm run validate -- --tools <file.yaml>     # Validate a single tool YAML file

# Release (see RELEASING.md)
npm run release:prepare:patch   # Patch version bump (no commit)
npm run release:prepare:minor   # Minor version bump (no commit)
npm run release:finalize        # Commit, tag, and push
```

### Run the server with npx

```bash
npx -y @ibm/ibmi-mcp-server@latest --transport http --tools /path/to/tools.yaml
```

## Architecture

### Core Pattern: "Logic Throws, Handler Catches"

Built-in tools are single `*.tool.ts` files in `packages/server/src/ibmi-mcp-server/tools/`, each created with `defineTool` from `packages/server/src/mcp-server/tools/utils/tool-factory.ts`:

- **`logic` function** - Pure business logic. Throws `McpError` on failure. No try/catch for response formatting.
- **Tool factory (`createHandler`)** - Handler layer. Wraps logic in try/catch, formats responses via `ErrorHandler`.

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
│   │   ├── mcp-server/
│   │   │   ├── server.ts           # createMcpServerInstance factory, initializeAndStartServer
│   │   │   ├── tools/utils/        # defineTool (tool-factory.ts)
│   │   │   └── transports/         # stdio/ (SDK serveStdio), http/ (SDK createMcpHandler in a Hono app; TLS listener, clientAddress.ts), auth/ (oauth, builtinOAuth, ibmi)
│   │   ├── ibmi-mcp-server/        # Tools, services, security
│   │   │   ├── oauth/              # Built-in authorization server: sign-in page, grant manager, Mapepire session, admin socket (contracts.ts lists the modules)
│   │   │   ├── services/           # queryRouter.ts (where every tool's SQL leaves from), connection pools
│   │   │   └── tools/              # Built-in *.tool.ts files
│   │   ├── utils/                  # telemetry, logger, formatting
│   │   └── types-global/           # McpError, JsonRpcErrorCode
│   └── tests/
└── cli/                            # @ibm/ibmi-cli
    ├── src/
    │   ├── index.ts                # CLI entry (ibmi bin): parses argv
    │   ├── program.ts              # createProgram(): global options, command registration
    │   ├── commands/               # 13 commands
    │   ├── config/                 # ~/.ibmi/config.yaml loader
    │   ├── formatters/
    │   └── utils/
    └── tests/
```

CLI imports server internals via the `exports` subpath surface:
`@ibm/ibmi-mcp-server/tools`, `/services`, `/context`, `/formatting`.

### YAML-Driven SQL Tools

SQL tools are defined declaratively in `tools/**/*.yaml`:

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

Load tools via `--tools ./tools/<dir>/<file>.yaml` and select toolsets via `--toolsets toolset_name`.

### Key Services

Paths are relative to `packages/server/src/ibmi-mcp-server/`:

- **Query router** (`services/queryRouter.ts`) - The one place a tool's SQL leaves from. Built-in tools and the YAML tool factory call its `executeQuery` / `executeQueryWithPagination`, never a pool. It picks the caller's own IBM i connection (built-in sign-on) or a pool (every other mode).
- **SourceManager** (`services/sourceManager.ts`) - Mapepire connection pooling
- **Grant manager** (`oauth/grantManager.ts`) - Built-in sign-on only: one Mapepire connection per signed-on user, sealed passwords, token rotation, idle close and reconnect
- **SqlSecurityValidator** (`utils/security/sqlSecurityValidator.ts`) - Enforces read-only queries by default
- **ToolProcessor** (`utils/config/toolProcessor.ts`) - YAML tool hydration and registration

### Authentication

`MCP_AUTH_MODE` selects HTTP authentication (the stdio transport never authenticates):

- `none` (default) - local development.
- `oauth` with `OAUTH_ISSUER_URL` unset - **built-in IBM i sign-on**. The server is its own OAuth 2.1 authorization server (`packages/server/src/ibmi-mcp-server/oauth/`): users sign on with an IBM i user profile at a page it serves, and every tool runs SQL on a Mapepire connection signed on as that user. No service pool exists, `DB2i_PASS` must be unset, and a tool call without a sign-on throws. The resource-server side and the startup refusals are in `packages/server/src/mcp-server/transports/auth/builtinOAuth.ts`.
- `oauth` with `OAUTH_ISSUER_URL` set - **external authorization server**. The server only verifies JWT access tokens (`transports/auth/oauth.ts`); all SQL runs as the `DB2i_USER` service account.
- `ibmi` - deprecated IBM i token authentication (`/api/v1/auth`).

In `oauth/`, passwords, authorization codes and refresh tokens are handled as `Buffer`s from `Buffer.allocUnsafeSlow`, never as strings, and are zero-filled by whoever allocated them. None of them, and nothing Mapepire answers to a sign-on, may appear in a log line, an error message or a thrown error. Tests there run against the in-process fake in `packages/server/tests/ibmi-mcp-server/oauth/fakeMapepire.ts`; never against a real IBM i.

Operator docs: `docs/server-config/oauth*.mdx` (setup in `oauth-ibmi-signon.mdx`, settings in `oauth-reference.mdx`). Security design notes (what is stored where, threat model, what was tested): `packages/server/src/ibmi-mcp-server/oauth/SECURITY.md`. Write user docs with the `user-docs` skill: internals and test history go in `SECURITY.md`, not the docs site.

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

Follow the existing tools in `packages/server/src/ibmi-mcp-server/tools/` (e.g. `listSchemas.tool.ts`):

1. Create `myTool.tool.ts`: define Zod input/output schemas and a logic function that throws on error, then export the result of `defineTool({ name, description, inputSchema, outputSchema, logic, ... })`. Run SQL through `executeQuery` or `executeQueryWithPagination` of `services/queryRouter.ts`, not through a connection pool, so that the tool also works when users sign on with their own IBM i profile
2. Import it in `packages/server/src/ibmi-mcp-server/tools/index.ts`
3. Add it to the array returned by `getAllToolDefinitions()`

### YAML SQL Tools

1. Add tool definition to appropriate `tools/**/*.yaml` file
2. Use parameter binding (`:param_name`) - never string interpolation
3. Include `FETCH FIRST N ROWS ONLY` for result limiting
4. Set `readOnlyHint: true` for SELECT queries
5. Run `npm run validate -- --tools <file.yaml>` to check syntax

## Testing

- Framework: Vitest
- Location: `packages/server/tests/` and `packages/cli/tests/` (each mirrors its `src/` structure)
- Prefer integration tests over mocked unit tests

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
| `MCP_LOG_LEVEL` | `debug`, `info`, `notice`, `warning`, `error`, `crit`, `alert`, `emerg` |
| `DB2i_SERVER_CERT_FILE`, `DB2i_CA_FILE` | Built-in sign-on: how the Mapepire certificate is verified (exact certificate, or CA) |
| `MCP_AUTH_MODE` | HTTP authentication: `none` (default), `oauth`, `ibmi` (deprecated) |
| `MCP_RESOURCE_URL` | Public URL of the MCP endpoint; required with `MCP_AUTH_MODE=oauth` |
| `OAUTH_ISSUER_URL` | Issuer of an external authorization server. Unset with `MCP_AUTH_MODE=oauth` selects the built-in IBM i sign-on (then `DB2i_PASS` must be unset) |
| `OAUTH_*` (others) | Built-in sign-on policy: `OAUTH_SIGNON_ALLOWED_CIDRS`, `OAUTH_CODE_ADDRESS_BINDING`, `OAUTH_GRANT_MAX_HOURS`, `OAUTH_IDLE_CLOSE_MINUTES`, `OAUTH_MAX_CONNECTIONS`, `OAUTH_ALLOWED_PROFILES`, `OAUTH_ALLOW_PRIVILEGED_PROFILES`, `OAUTH_SIGNON_MAX_FAILURES`, `OAUTH_ALLOW_LOOPBACK_REDIRECTS`, `OAUTH_REDIRECT_URIS`, `OAUTH_ADMIN_SOCKET` |
| `MCP_TLS_CERT_FILE`, `MCP_TLS_KEY_FILE` | PEM files; with both set the HTTP server listens with TLS (any auth mode) |
| `MCP_TRUSTED_PROXIES` | IP addresses / CIDR ranges of reverse proxies whose `X-Forwarded-*` headers are believed |

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
