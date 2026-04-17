# Repository Guidelines

## Mission & Outcomes

This project exists to make it easy to build MCP tools and agents for IBM i systems. Prioritize ergonomics, observability, and safe Db2 for i defaults. Every change should simplify tool creation, expand IBM i coverage, or harden reliability for downstream agent builders.

## Architecture & Modules

npm workspaces monorepo. Two published packages:

- `@ibm/ibmi-mcp-server` (`packages/server/`) — MCP server runtime. Bootstraps from `packages/server/src/index.ts`, wiring the core server in `packages/server/src/mcp-server/server.ts` and IBM i extensions in `packages/server/src/ibmi-mcp-server/`. Transports live in `packages/server/src/mcp-server/transports/` (stdio plus streamable HTTP via Hono). Each tool follows the mandate: pure logic in `logic.ts`, registration and error handling in `registration.ts`. YAML-driven data access flows through `packages/server/src/ibmi-mcp-server/services/` where `SourceManager` builds Mapepire pools and `SqlSecurityValidator` enforces read-only guardrails. Observability is centralized in `packages/server/src/utils/telemetry/` and context-aware logging helpers under `packages/server/src/utils/internal/`. A public `exports` surface lives at `packages/server/src/public/` (`tools`, `services`, `context`, `formatting`) and is the stable contract consumed by the CLI.
- `@ibm/ibmi-cli` (`packages/cli/`) — the `ibmi` command-line interface. Depends on `@ibm/ibmi-mcp-server` at an exact-pinned version, imports tool logic via the `@ibm/ibmi-mcp-server/{tools,services,context,formatting}` subpaths, and invokes `.logic()` directly (no MCP protocol overhead for local use).

Both packages co-version: a single `v*` git tag releases a matched pair. See [RELEASING.md](./RELEASING.md).

## SQL Tooling Workflow

Declare SQL tools in YAML under `tools/` (`performance.yaml`, `sys-admin.yaml`) with `sources`, `tools`, and `toolsets`. The server hydrates them via `TOOLS_YAML_PATH`, validates queries, and loads requested toolsets (`--toolsets`). Prefer YAML statements for standard IBM i services like `QSYS2.SYSTEM_STATUS`; use dynamic `executeSql` only when strictly necessary and document it. Mirror new toolsets in `docs/` and seed mocks in `packages/server/tests/fixtures/`.

## Authentication & Security

Optional IBM i HTTP auth issues bearer tokens at `/api/v1/auth` when `IBMI_HTTP_AUTH_ENABLED=true`, creating per-token pools governed by `IBMI_AUTH_TOKEN_EXPIRY_SECONDS`. Development may enable plain HTTP (`IBMI_AUTH_ALLOW_HTTP=true`), but production paths must describe TLS, pool cleanup, and secret handling. Never commit credentials; keep `.env` local and validate schema changes with `npm run validate`.

## Testing & Quality

Vitest drives validation. Run `npm run test` at repo root (delegates to both workspaces via `--workspaces --if-present`) for fast feedback, `npm run test:coverage` before merging, and `npm run lint`/`npm run format` to uphold Prettier + ESLint defaults (two-space indentation, camelCase identifiers, PascalCase classes, SCREAMING_SNAKE constants). Server suites live under `packages/server/tests/mcp-server/` or service directories; CLI suites under `packages/cli/tests/`. Ensure integration specs cover logic/registration separation plus SQL security checks.

## Agents & Toolsets

Example agents live in `packages/server/tests/agents/` with a uv-based Python harness (`agent.py`) plus scripts for tool annotations and resource discovery. Keep these examples aligned with shipped YAML toolsets, document workflows in `agent.md`, and provide prompts when introducing new capabilities.

## Contribution Flow

Commits generally follow conventional prefixes (`feat:`, `fix:`, `chore:`) or scoped `Feat/topic`. Keep changes small, reference affected toolsets or auth flags in messages, and list validation commands in PR descriptions. Always confirm `npm run build` before review and highlight impacts to security posture or IBM i connectivity.
