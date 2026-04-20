# syntax=docker/dockerfile:1.7
#
# Build context: REPO ROOT (npm workspaces monorepo uses a single root
# package-lock.json shared by every workspace). The workflow must set
# `context: .` so this Dockerfile can see the root lockfile.
#
# Produces a runtime image for @ibm/ibmi-mcp-server only — the CLI
# workspace is not shipped.

# ---- Base ----
FROM node:bookworm-slim AS base
WORKDIR /app

# System updates + recent npm (lockfileVersion 3 needs npm >= 7)
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates \
    && npm install -g npm@latest \
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
# agents/, and .env files out of the build context.)
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

# Non-root user + npm cache dir
RUN groupadd -r appgroup \
    && useradd -r -g appgroup appuser \
    && chown -R appuser:appgroup /app \
    && mkdir -p /home/appuser/.npm \
    && chown -R appuser:appgroup /home/appuser/.npm

USER appuser

ENV MCP_TRANSPORT_TYPE=http
EXPOSE 3010

# Run node directly on the built entry rather than via `npx` — avoids
# any bin-resolution surprises and gives a cleaner PID 1.
CMD ["node", "packages/server/dist/index.js"]
