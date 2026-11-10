# Repository Guidelines

## Mission & Outcomes

This project exists to make it easy to build MCP tools and agents for IBM i systems. Prioritize ergonomics, observability, and safe Db2 for i defaults. Every change should simplify tool creation, expand IBM i coverage, or harden reliability for downstream agent builders.

## Architecture & Modules

npm workspaces monorepo. Two published packages:

- `@ibm/ibmi-mcp-server` (`packages/server/`) — MCP server runtime. Bootstraps from `packages/server/src/index.ts`, wiring the core server in `packages/server/src/mcp-server/server.ts` and IBM i extensions in `packages/server/src/ibmi-mcp-server/`. The server runs on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) and is stateless: `createMcpServerInstance` in `server.ts` is a factory the SDK calls once per HTTP request or once per stdio connection, so it must stay cheap (no file reads, no connections). Transports live in `packages/server/src/mcp-server/transports/`: `stdio/` wraps the SDK's `serveStdio`, and `http/` mounts the SDK's `createMcpHandler` in a Hono app that adds Host/Origin validation, CORS, authentication, rate limiting and `/healthz`. One endpoint serves MCP protocol revision 2026-07-28 and earlier clients; there are no sessions. Each built-in tool is a single `*.tool.ts` file in `packages/server/src/ibmi-mcp-server/tools/` created with `defineTool` (`packages/server/src/mcp-server/tools/utils/tool-factory.ts`): pure logic that throws in the tool's `logic` function, registration and error handling in the factory. YAML-driven data access flows through `packages/server/src/ibmi-mcp-server/services/` where `SourceManager` builds Mapepire pools, while `SqlSecurityValidator` (`packages/server/src/ibmi-mcp-server/utils/security/`) enforces read-only guardrails. Observability is centralized in `packages/server/src/utils/telemetry/` and context-aware logging helpers under `packages/server/src/utils/internal/`. A public `exports` surface lives at `packages/server/src/public/` (`tools`, `services`, `context`, `formatting`) and is the stable contract consumed by the CLI.
- `@ibm/ibmi-cli` (`packages/cli/`) — the `ibmi` command-line interface. Depends on `@ibm/ibmi-mcp-server` at an exact-pinned version, imports tool logic via the `@ibm/ibmi-mcp-server/{tools,services,context,formatting}` subpaths, and invokes `.logic()` directly (no MCP protocol overhead for local use).

Both packages co-version: a single `v*` git tag releases a matched pair. See [RELEASING.md](./RELEASING.md).

## SQL Tooling Workflow

Declare SQL tools in YAML under `tools/` (`performance/performance.yaml`, `sys-admin/sys-admin.yaml`) with `sources`, `tools`, and `toolsets`. The server hydrates them via `TOOLS_YAML_PATH`, validates queries, and loads requested toolsets (`--toolsets`). Prefer YAML statements for standard IBM i services like `QSYS2.SYSTEM_STATUS`; use dynamic `executeSql` only when strictly necessary and document it. Mirror new toolsets in `docs/` and seed mocks in `packages/server/tests/fixtures/`.

## Authentication & Security

`MCP_AUTH_MODE` selects HTTP authentication: `none` (default; local development and stdio), `oauth`, or `ibmi`. `oauth` is the mode for multi-user remote deployments: the server is an OAuth 2.1 resource server per the MCP authorization specification (`packages/server/src/mcp-server/transports/auth/oauth.ts`). It verifies JWT access tokens against the issuer's JWKS, serves Protected Resource Metadata at `/.well-known/oauth-protected-resource`, and requires `MCP_RESOURCE_URL` and `OAUTH_ISSUER_URL`. Tokens identify the caller only; all SQL runs as the `DB2i_USER` service account. `ibmi` (IBM i HTTP token auth: `/api/v1/auth`, `IBMI_HTTP_AUTH_ENABLED`, `IBMI_AUTH_*`, per-token pools) is deprecated and will be removed in a future major release; do not build on it. The startup posture guard (`transports/http/hostValidation.ts`) refuses an unauthenticated HTTP server on a non-loopback bind while IBM i credentials are configured. Never commit credentials; keep `.env` local and validate schema changes with `npm run validate`.

## Testing & Quality

Vitest drives validation. Run `npm run test` at repo root (delegates to both workspaces via `--workspaces --if-present`) for fast feedback, `npm run test:coverage` before merging, and `npm run lint`/`npm run format` to uphold Prettier + ESLint defaults (two-space indentation, camelCase identifiers, PascalCase classes, SCREAMING_SNAKE constants). `npm run format` formats both packages; `npm run format:check` checks without writing (not yet enforced in CI). CI (`.github/workflows/ci.yml`) runs build, typecheck, lint and test on Node 22 and 24 for every pull request and push to `main`; Node 22 is the minimum supported version. Server suites live under `packages/server/tests/mcp-server/` or service directories; CLI suites under `packages/cli/tests/`. Ensure integration specs cover tool logic plus SQL security checks.

## Agents & Toolsets

Example agents live in `client/` with a uv-based Python harness (`agent.py`) plus scripts for tool annotations and resource discovery. Keep these examples aligned with shipped YAML toolsets, document workflows in `client/README.md`, and provide prompts when introducing new capabilities.

## Contribution Flow

Commits generally follow conventional prefixes (`feat:`, `fix:`, `chore:`) or scoped `Feat/topic`. Keep changes small, reference affected toolsets or auth flags in messages, and list validation commands in PR descriptions. Always confirm `npm run build` before review and highlight impacts to security posture or IBM i connectivity.
