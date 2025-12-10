# Repository Guidelines

## Mission & Outcomes

This project exists to make it easy to build MCP tools and agents for IBM i systems. Prioritize ergonomics, observability, and safe Db2 for i defaults. Every change should simplify tool creation, expand IBM i coverage, or harden reliability for downstream agent builders.

## Architecture & Modules

Runtime bootstraps from `src/index.ts`, wiring the core server in `src/mcp-server/server.ts` and IBM i extensions in `src/ibmi-mcp-server/`. Transports live in `src/mcp-server/transports/` (stdio plus streamable HTTP via Hono). Each tool follows the mandate: pure logic in `logic.ts`, registration and error handling in `registration.ts`. YAML-driven data access flows through `src/ibmi-mcp-server/services/` where `SourceManager` builds Mapepire pools and `SqlSecurityValidator` enforces read-only guardrails. Observability is centralized in `src/utils/telemetry/` and context-aware logging helpers under `src/utils/internal/`.

## SQL Tooling Workflow

Declare SQL tools in YAML under `tools/` (`performance.yaml`, `sys-admin.yaml`) with `sources`, `tools`, and `toolsets`. The server hydrates them via `TOOLS_YAML_PATH`, validates queries, and loads requested toolsets (`--toolsets`). Prefer YAML statements for standard IBM i services like `QSYS2.SYSTEM_STATUS`; use dynamic `executeSql` only when strictly necessary and document it. Mirror new toolsets in `docs/` and seed mocks in `tests/fixtures/`.

## Authentication & Security

Optional IBM i HTTP auth issues bearer tokens at `/api/v1/auth` when `IBMI_HTTP_AUTH_ENABLED=true`, creating per-token pools governed by `IBMI_AUTH_TOKEN_EXPIRY_SECONDS`. Development may enable plain HTTP (`IBMI_AUTH_ALLOW_HTTP=true`), but production paths must describe TLS, pool cleanup, and secret handling. Never commit credentials; keep `.env` local and validate schema changes with `npm run validate`.

## Testing & Quality

Vitest drives validation. Run `npm run test` for fast feedback, `npm run test:coverage` before merging, and `npm run lint`/`npm run format` to uphold Prettier + ESLint defaults (two-space indentation, camelCase identifiers, PascalCase classes, SCREAMING_SNAKE constants). Place suites under `tests/mcp-server/` or service directories, and ensure integration specs cover logic/registration separation plus SQL security checks.

## Agents & Toolsets

Example agents live in `tests/agents/` with a uv-based Python harness (`agent.py`) plus scripts for tool annotations and resource discovery. Keep these examples aligned with shipped YAML toolsets, document workflows in `agent.md`, and provide prompts when introducing new capabilities.

## Contribution Flow

Commits generally follow conventional prefixes (`feat:`, `fix:`, `chore:`) or scoped `Feat/topic`. Keep changes small, reference affected toolsets or auth flags in messages, and list validation commands in PR descriptions. Always confirm `npm run build` before review and highlight impacts to security posture or IBM i connectivity.
