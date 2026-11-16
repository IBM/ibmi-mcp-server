# syntax=docker/dockerfile:1.7
#
# Build context: REPO ROOT (npm workspaces monorepo uses a single root
# package-lock.json shared by every workspace). The workflow must set
# `context: .` so this Dockerfile can see the root lockfile.
#
# Produces a runtime image for @ibm/ibmi-mcp-server only — the CLI
# workspace is not shipped.

# ---- Base ----
FROM node:22-bookworm-slim AS base
WORKDIR /app

# System updates. The npm bundled with Node 22 reads lockfileVersion 3.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ---- Builder: install all deps, build the server workspace ----
FROM base AS builder
WORKDIR /app
ENV NODE_ENV=development

# Copy manifests first so the Docker layer cache is invalidated only when
# dependency declarations change, not on every source edit. Every workspace
# package.json must be present for `npm ci` to resolve the workspace graph
# that the root lockfile describes.
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/cli/package.json ./packages/cli/

RUN npm ci

# Copy the full source tree and build only the server workspace.
# (.dockerignore keeps node_modules/, dist/, .git/, .github/, .claude/,
# agents/, .env files and credential files out of the build context, at
# any depth.)
COPY . .

RUN npm run build -w @ibm/ibmi-mcp-server

# ---- Production dependencies only ----
# Separate stage so the runtime image carries only what the server needs
# to execute — no TypeScript, no test frameworks, no CLI workspace deps.
FROM base AS prod-deps
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/cli/package.json ./packages/cli/

# --workspace=@ibm/ibmi-mcp-server + --include-workspace-root installs
# exactly the production deps the server needs plus anything hoisted to
# the root. The CLI workspace's deps are skipped.
RUN npm ci --omit=dev \
      --workspace=@ibm/ibmi-mcp-server \
      --include-workspace-root

# ---- Runner ----
FROM base AS runner
WORKDIR /app

# node_modules carries a symlink `@ibm/ibmi-mcp-server -> ../packages/server`.
# Copying node_modules from prod-deps preserves the symlink; populating
# packages/server/ from the builder makes the symlink resolve to the
# actual built dist output.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/server/dist ./packages/server/dist

# Non-root user that owns its home directory (-m): the default LOGS_DIR,
# ~/.ibmi-mcp-server/logs, is created there on first start. On a read-only
# root filesystem that directory cannot be created and the server logs to
# stderr only; mount a volume or tmpfs at LOGS_DIR to keep log files.
RUN groupadd -r appgroup \
    && useradd -r -m -g appgroup appuser \
    && chown -R appuser:appgroup /app

USER appuser

ENV MCP_TRANSPORT_TYPE=http
# Containers must bind all interfaces to be reachable through published ports.
# Set explicitly — the server defaults to loopback-only (DNS rebinding hardening).
# Do NOT set MCP_ALLOW_UNAUTHENTICATED_HTTP here: with IBM i credentials present
# and MCP_AUTH_MODE=none the server intentionally refuses to start; that override
# is the operator's explicit, per-deployment decision.
ENV MCP_HTTP_HOST=0.0.0.0
EXPOSE 3010

# /healthz answers on the configured port; loopback is always an allowed Host.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.MCP_HTTP_PORT || 3010) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Run node directly on the built entry rather than via `npx` — avoids
# any bin-resolution surprises and gives a cleaner PID 1.
CMD ["node", "packages/server/dist/index.js"]
