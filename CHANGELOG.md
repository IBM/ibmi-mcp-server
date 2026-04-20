# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [0.5.1](https://github.com/IBM/ibmi-mcp-server/compare/v0.5.0...v0.5.1) (2026-04-20)

Consolidates the fetch-limit UX introduced in 0.5.0 before downstream adoption locks in the current behavior ([#146](https://github.com/IBM/ibmi-mcp-server/pull/146)). Ships CI reliability fixes and root-level README coverage for the new two-package layout.

### Changed

* **`rowsToFetch` and `fetchAllRows` now compose instead of colliding.** `fetchAllRows: true` is the pagination policy; when `rowsToFetch` is also set it becomes the per-fetch page size. The previous "`rowsToFetch` wins, `fetchAllRows` ignored" precedence rule has been removed — the warning log it emitted is gone too, since the two fields no longer conflict. YAML tools that set only one field behave identically; tools that set both now paginate with a custom page size instead of silently ignoring `fetchAllRows`.

* **Pagination safety ceiling is now row-based, not iteration-based.** The internal loop now terminates at `IBMI_PAGINATION_MAX_ROWS` rows of accumulated data rather than at 100 `fetchMore` iterations, so the effective row ceiling is stable regardless of per-fetch page size. Previously a larger page size implicitly granted a proportionally larger cap. When a result is truncated at the ceiling, the server emits a warning log and flags the response; the CLI surfaces the truncation in its output footer.

* **`execute_sql` built-in tool inherits shared pagination defaults.** Previously hard-coded a 1000-row page size, producing an effective ~100,000-row ceiling inconsistent with YAML tools. Now reads `IBMI_PAGINATION_DEFAULT_PAGE_SIZE` / `IBMI_PAGINATION_MAX_ROWS` from config — matching every YAML tool and the documented 30,000-row cap. Operators running bulk CLI exports can raise `IBMI_PAGINATION_MAX_ROWS`.

### Added

* **Two new environment variables** for tuning pagination:
  * `IBMI_PAGINATION_DEFAULT_PAGE_SIZE` (default `1000`) — rows per `fetchMore` call when a tool paginates without specifying its own page size.
  * `IBMI_PAGINATION_MAX_ROWS` (default `30000`) — hard upper bound on total rows from a paginated tool call.

* **CLI truncation display.** The `ibmi tool run` footer now shows `(result capped — raise IBMI_PAGINATION_MAX_ROWS or narrow the query)` when a paginated result hits the ceiling, so callers know the output was clipped.

### Fixed

* **Publish workflow is now idempotent.** The release workflow skips `npm publish` when the target version already exists in the registry, so re-running on a failed job won't collide with a successful upload. Adds a `workflow_dispatch` trigger for manual re-runs against an existing tag ([e265a65](https://github.com/IBM/ibmi-mcp-server/commit/e265a65e3567a4beee4208f086deb358ee1b39be)).

### Documentation

* **Root README rewritten for the two-package layout.** Top-level README now explains the split between `@ibm/ibmi-mcp-server` and `@ibm/ibmi-cli`, clarifies install paths for each, and links into Mintlify + package READMEs as the authoritative deep-dive sources ([c22ebf2](https://github.com/IBM/ibmi-mcp-server/commit/c22ebf2d27e14b57601779f296a93a4f7621c0aa)).

### Migration

No YAML changes required. Tools that set only `rowsToFetch` or only `fetchAllRows` behave as before. Tools that set **both** fields will now paginate with the custom page size instead of the previous "`rowsToFetch` wins" behavior — if that transition is undesirable, remove `fetchAllRows`. Callers relying on `execute_sql` to return up to ~100,000 rows should raise `IBMI_PAGINATION_MAX_ROWS` explicitly; otherwise the effective ceiling is now the documented 30,000.

## [0.5.0](https://github.com/IBM/ibmi-mcp-server/compare/v0.4.5...v0.5.0) (2026-04-20)

This release splits the `ibmi` command-line tool into its own `@ibm/ibmi-cli` npm package, adds first-class JDBC connection tuning to YAML sources, introduces per-tool row-fetch controls, and extends the SQL security validator to cover `ibmi tool` execution.


### ⚠ BREAKING CHANGES

* **CLI split into `@ibm/ibmi-cli`** — The `ibmi` binary no longer ships with `@ibm/ibmi-mcp-server`. Upgrading from 0.4.x requires installing both packages. Runtime MCP server usage (`npx -y @ibm/ibmi-mcp-server@latest ...`) is unchanged.

  **Migration:**
  ```bash
  # Before (v0.4.x) — one install, both binaries
  npm i -g @ibm/ibmi-mcp-server

  # After (v0.5.0) — separate packages
  npm i -g @ibm/ibmi-mcp-server    # provides `ibmi-mcp-server`
  npm i -g @ibm/ibmi-cli           # provides `ibmi`
  ```

  `@ibm/ibmi-cli` exact-pins its `@ibm/ibmi-mcp-server` dependency, so installing `@ibm/ibmi-cli@0.5.0` always pulls in `@ibm/ibmi-mcp-server@0.5.0` — the two packages co-version on every release ([#144](https://github.com/IBM/ibmi-mcp-server/pull/144)).


### Features

* **Monorepo split — `@ibm/ibmi-cli` ships as its own package.** The `ibmi` CLI is now a standalone npm package. `@ibm/ibmi-mcp-server` exposes a stable public API surface via subpath exports (`/tools`, `/services`, `/context`, `/formatting`) that downstream agents and the CLI import directly — treat these subpaths as the contract ([#144](https://github.com/IBM/ibmi-mcp-server/pull/144))

* **JDBC connection options on YAML sources.** Sources now accept a `jdbc-options` passthrough block mapped directly to Mapepire's `JDBCOptions` — naming convention, library list, transaction isolation, date format, and any other JDBC-level tunable. Options may also be supplied via the `DB2i_JDBC_OPTIONS` environment variable for containerized deployments (env overrides YAML on a per-key basis) ([#141](https://github.com/IBM/ibmi-mcp-server/pull/141))

* **Per-tool row fetch controls (`rowsToFetch` / `fetchAllRows`).** SQL tools can now decide per-tool whether a query caps at a fixed page size (`rowsToFetch: <n>`) or streams every matching row (`fetchAllRows: true`). When both are set, `rowsToFetch` takes precedence as the safer default and a warning is logged ([#142](https://github.com/IBM/ibmi-mcp-server/pull/142), precedence clarified in [#145](https://github.com/IBM/ibmi-mcp-server/pull/145))

* **SQL security validation on `ibmi tool` execution.** YAML tool runs now flow through the same `SqlSecurityValidator` used by the built-in `execute_sql` tool. Write statements in read-only contexts are rejected before they reach the database — an additional safety layer on top of existing `readOnlyHint` tool configuration ([#136](https://github.com/IBM/ibmi-mcp-server/pull/136))


### Bug Fixes

* **Documentation:** Updated installation commands and paths in the getting-started guide and configuration docs to match the new two-package layout ([21a4c1c](https://github.com/IBM/ibmi-mcp-server/commit/21a4c1c72bcff8b025be9c4aa84a936f18eb2421), [955e71e](https://github.com/IBM/ibmi-mcp-server/commit/955e71eb1aea623319b0a01e794030ee5370d672))

### [0.4.5](https://github.com/IBM/ibmi-mcp-server/compare/v0.4.4...v0.4.5) (2026-03-24)


### Features

* **`ibmi describe` command**: Generate DDL (CREATE statements) for one or more SQL objects using `QSYS2.GENERATE_SQL`. Accepts comma-delimited `LIBRARY.OBJECT` references with an optional `--type` flag for views, indexes, procedures, and other object types ([#132](https://github.com/IBM/ibmi-mcp-server/issues/132))
* **Multi-system SQL execution**: Run the same SQL query against multiple IBM i systems in parallel with `ibmi sql "..." --system dev,prod`. Results include a `SYSTEM` column and per-system timing. JSON output provides an aggregate envelope with `systems_ok`/`systems_failed` counts ([#132](https://github.com/IBM/ibmi-mcp-server/issues/132))


### Bug Fixes

* **Container security**: Update Dockerfile base image and apply OS-level package upgrades to resolve CVEs in `libcrypto3`, `libssl3`, and bundled npm dependencies (`minimatch`, `tar`, `glob`, `cross-spawn`, `flatted`) ([#134](https://github.com/IBM/ibmi-mcp-server/issues/134))

### [0.4.4](https://github.com/IBM/ibmi-mcp-server/compare/v0.4.3...v0.4.4) (2026-03-15)


### Bug Fixes

* **CLI Database Commands**: Fix `ibmi sql` and other database commands failing with "Db2i configuration not found" when run from directories without a `.env` file. The global config (`~/.ibmi/config.yaml`) now correctly provides credentials to all CLI commands regardless of working directory ([#131](https://github.com/IBM/ibmi-mcp-server/issues/131))

### [0.4.3](https://github.com/IBM/ibmi-mcp-server/compare/v0.4.2...v0.4.3) (2026-03-15)


### Features

* **config:** add walk-up boundary and ibmi config show command ([#130](https://github.com/IBM/ibmi-mcp-server/issues/130)) ([d050991](https://github.com/IBM/ibmi-mcp-server/commit/d050991ae578105800adb63d3b5330c674b04956))


### Bug Fixes

* audit npm security fixes ([ecb451a](https://github.com/IBM/ibmi-mcp-server/commit/ecb451ad9f4a44d7c0dfc5b7ea5394db867056e8))

### [0.4.2](https://github.com/IBM/ibmi-mcp-server/compare/v0.4.1...v0.4.2) (2026-03-09)


### Bug Fixes

* **`--builtin-tools` CLI Flag**: Fix `--builtin-tools` flag not registering the default text-to-SQL toolset. ES module evaluation timing caused tool definitions to be captured before CLI overrides were applied; tool registration now defers config evaluation to runtime ([2134d79](https://github.com/IBM/ibmi-mcp-server/commit/2134d79f8be14e2e37637d9f10bb87da2b2e38be))

* **UDTF Column Validation Transparency**: `validate_query` now reports columns from UDTF output (e.g., `TABLE(SYSTOOLS.AUDIT_JOURNAL_CP(...))`) as "skipped" instead of silently passing validation. Skipped columns are surfaced in the response so users can manually verify they match the function's result set ([2134d79](https://github.com/IBM/ibmi-mcp-server/commit/2134d79f8be14e2e37637d9f10bb87da2b2e38be))

### [0.4.1](https://github.com/IBM/ibmi-mcp-server/compare/v0.4.0...v0.4.1) (2026-03-06)


### ⚠ BREAKING CHANGES

* **cli:** IBMI_ENABLE_DEFAULT_TOOLS now defaults to false. Users
who relied on the default text-to-SQL toolset must pass --builtin-tools
or set IBMI_ENABLE_DEFAULT_TOOLS=true.

Signed-off-by: Adam Shedivy <ajshedivyaj@gmail.com>

### Features

* **cli:** add --builtin-tools and --execute-sql flags with opt-in defaults ([4437369](https://github.com/IBM/ibmi-mcp-server/commit/443736912b2c905acc43d394915e3f435611252a))
* **env:** update .env.example with new tool configurations and rate limiting settings ([f2bbd12](https://github.com/IBM/ibmi-mcp-server/commit/f2bbd12a5ea283470b3fc86adc9bd3e3aaf025be))

## [0.4.0](https://github.com/IBM/ibmi-mcp-server/compare/v0.3.2...v0.4.0) (2026-03-06)


### Features

* **IBM i CLI**: New command-line interface for querying and managing IBM i systems directly from the terminal. Includes multi-system configuration, YAML tool execution, and an interactive agent mode for natural language workflows ([#126](https://github.com/IBM/ibmi-mcp-server/issues/126))
* **Default Text-to-SQL Toolset**: Ship a built-in toolset with paginated result support, enabling AI agents to query IBM i databases out of the box without custom YAML configuration ([#120](https://github.com/IBM/ibmi-mcp-server/issues/120))


### Bug Fixes

* **Security Dependency Updates**: Patch `hono` (4.11.4 → 4.12.5) and `@hono/node-server` (1.19.7 → 1.19.11) to fix arbitrary file access via serveStatic, authorization bypass via encoded slashes, SSE injection, and cookie attribute injection vulnerabilities ([#341](https://github.com/IBM/ibmi-mcp-server/issues/341), [#342](https://github.com/IBM/ibmi-mcp-server/issues/342), [#343](https://github.com/IBM/ibmi-mcp-server/issues/343), [#344](https://github.com/IBM/ibmi-mcp-server/issues/344))


### Documentation

* **CLI Reference Guide**: Add comprehensive CLI documentation with 7 pages covering getting started, commands, configuration, YAML tools, output formats, and agent integration ([#127](https://github.com/IBM/ibmi-mcp-server/issues/127))

### [0.3.2](https://github.com/IBM/ibmi-mcp-server/compare/v0.3.1...v0.3.2) (2026-03-04)


### Features

* **Connection Pool Timeouts**: Configure idle connection cleanup and per-query timeouts to prevent resource leaks and long-running queries. Set `IBMI_POOL_IDLE_TIMEOUT_MS` and `IBMI_POOL_QUERY_TIMEOUT_MS` environment variables to tune pool behavior for your workload ([#121](https://github.com/IBM/ibmi-mcp-server/issues/121)), closes [#117](https://github.com/IBM/ibmi-mcp-server/issues/117)


### Documentation

* **Container Deployment Guide**: Add comprehensive instructions for running the MCP server in Docker, Podman, and OpenShift containers, including multi-architecture image support ([#116](https://github.com/IBM/ibmi-mcp-server/issues/116))

### [0.3.1](https://github.com/IBM/ibmi-mcp-server/compare/v0.3.0...v0.3.1) (2026-02-22)


### Features

* **Configurable Rate Limiting**: Control request rate limits via environment variables (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_SKIP_IN_DEV`) for fine-tuned protection in production deployments ([#112](https://github.com/IBM/ibmi-mcp-server/issues/112))
* **Text-to-SQL Tools**: Add pre-built Text-to-SQL toolset and sample employee information toolset for natural language database querying ([#103](https://github.com/IBM/ibmi-mcp-server/issues/103))


### Bug Fixes

* **YAML Tool Security Validation**: Enforce SQL security validation on authenticated IBM i HTTP routes, closing a gap where YAML-defined tools bypassed read-only checks ([#108](https://github.com/IBM/ibmi-mcp-server/issues/108))


### Chores

* **Container Images**: Build and publish multi-architecture container images with release-triggered CI workflows

## [0.3.0](https://github.com/IBM/ibmi-mcp-server/compare/v0.2.0...v0.3.0) (2026-01-26)


### Features

#### SQL Parser & Security Enhancements

* **VS Code DB2i SQL Parser Integration**: Integrate experimental SQL parser from Code for IBM i VS Code extension ([#97](https://github.com/IBM/ibmi-mcp-server/issues/97)) ([f261684](https://github.com/IBM/ibmi-mcp-server/commit/f261684af08a73a8573876598f692fd79c219f8b))
  - Add comprehensive SQL parsing capabilities for Db2 for i syntax
  - Refactor SQL Security Validator to use VS Code DB2i parser for improved accuracy
  - Implement regex-based fallback validation for unparseable SQL queries
  - Add extensive test coverage for SQL tokenization, statement parsing, and security validation
  - Enhance SQL token and statement analysis with 2,000+ lines of parsing logic
  - See [language parser README](https://github.com/codefori/vscode-db2i/tree/main/src/language) for technical details

* **Read-Only SQL Execution Mode**: Add security validation for read-only SQL operations ([#92](https://github.com/IBM/ibmi-mcp-server/issues/92)) ([4f7b396](https://github.com/IBM/ibmi-mcp-server/commit/4f7b3960cdef2f9e05cd27677ff9db4b404a39cf))
  - Introduce `IBMI_EXECUTE_SQL_READONLY` environment variable to enforce read-only mode
  - Implement SQL syntax validation using IBM i's native `PARSE_STATEMENT` stored procedure
  - Prevent execution of write operations (INSERT, UPDATE, DELETE, CREATE, etc.) when enabled
  - Add comprehensive security checks to detect forbidden keywords and operations
  - Include detailed documentation and configuration examples for security-conscious deployments
  - Add 500+ lines of unit tests covering various SQL scenarios and validation cases


### Bug Fixes

* **SQL Template Syntax**: Replace deprecated template syntax with named parameters ([#95](https://github.com/IBM/ibmi-mcp-server/issues/95)) ([cac3c22](https://github.com/IBM/ibmi-mcp-server/commit/cac3c222b9ee99bb9684f3281bf0e881fc92d106)), closes [#94](https://github.com/IBM/ibmi-mcp-server/issues/94)
  - Update `check_command_audit_settings` tool to use `:command_names` named parameter syntax instead of deprecated `{{command_names}}` template syntax
  - Ensures compatibility with latest Mapepire query parameter handling


### Chores

* **Tool Consolidation**: Streamline default tools and implement factory pattern ([#91](https://github.com/IBM/ibmi-mcp-server/issues/91)) ([3a5e1e6](https://github.com/IBM/ibmi-mcp-server/commit/3a5e1e6e7963ec9d3e2c7d5fb72605842b4f9bd1))
  - Remove obsolete tools and test infrastructure (DuckDB service, cat fact fetcher, echo tool, image test tool)
  - Consolidate `execute_sql` and `generate_sql` tools into single-file implementations
  - Implement centralized factory pattern for tool registration and management
  - Add configuration support for built-in `execute_sql` tool
  - Clean up codebase with net reduction of ~3,600 lines across 55 files
  - Add comprehensive unit tests for tool factory functionality

* **Transport Layer Modernization**: Update dependencies and refactor transport managers ([#93](https://github.com/IBM/ibmi-mcp-server/issues/93)) ([d534e3c](https://github.com/IBM/ibmi-mcp-server/commit/d534e3c5783479f046e184bbf06128367ac5660a))
  - Upgrade `@modelcontextprotocol/sdk` to version 1.25.2
  - Add OpenTelemetry dependencies (`@opentelemetry/api`, `@opentelemetry/sdk-node`) for enhanced observability
  - Refactor transport managers to use `WebStandardStreamableHTTPServerTransport`
  - Migrate from Node.js-specific APIs to Web Standards API for better cross-platform compatibility
  - Remove deprecated utility files (`headerUtils.ts`, `honoNodeBridge.ts`)
  - Implement cleanup transform stream for improved resource management
  - Simplify request handling with unified `webRequest` interface

* **Developer Tools**: Add debug deployment script and update format script ([3bd2d2e](https://github.com/IBM/ibmi-mcp-server/commit/3bd2d2e860fe5dfff4b3bf3621ad1d247168830f))
  - Enhance development workflow with debugging utilities
  - Update code formatting scripts for consistency

## [0.2.0](https://github.com/IBM/ibmi-mcp-server/compare/v0.1.2...v0.2.0) (2025-12-18)


### Features

#### Deployment & Infrastructure

* **OpenShift Deployment**: Add complete OpenShift deployment configuration for both MCP server and gateway ([#70](https://github.com/IBM/ibmi-mcp-server/issues/70)) ([b0a7550](https://github.com/IBM/ibmi-mcp-server/commit/b0a75507272cf11eea0a7b31373d9e6b80848a88))
  - Add Kubernetes manifests for OpenShift deployment (BuildConfig, Deployment, Service, Route, ImageStream)
  - Configure MCP Context Forge gateway deployment with persistent volume claims
  - Include health check endpoints and container orchestration
  - Add comprehensive deployment documentation and instructions

* **Production Web Server Support**: Add nginx configuration guide for production deployments ([#72](https://github.com/IBM/ibmi-mcp-server/issues/72)) ([22c5153](https://github.com/IBM/ibmi-mcp-server/commit/22c5153ffe4210dbbad262019057a54ab086ce56))
  - Document nginx reverse proxy setup for MCP server
  - Include WebSocket upgrade configuration
  - Provide sample nginx configuration for production use

### Documentation

* **Major Documentation Reorganization**: Comprehensive restructuring of documentation for improved clarity and usability ([#83](https://github.com/IBM/ibmi-mcp-server/issues/83)) ([f3d5857](https://github.com/IBM/ibmi-mcp-server/commit/f3d58572259470a4a10358e29298d8c98574defe))
  - Reorganize README structure with clear navigation and table of contents
  - Enhance quick start guide with detailed SQL tool creation examples
  - Add documentation for pre-built toolsets and custom tool configuration
  - Move server-specific documentation to server directory
  - Simplify agent framework documentation
  - Add IBM Bob integration documentation
  - Update references to use latest npm package naming
  - Remove outdated agent and response format documentation
  - Add IBM i authentication guide
  - Fix logo duplication and improve formatting

* **SQL Tools Documentation**: Update quickstart guide with enhanced SQL tools section covering both pre-built and custom tool options ([8ba6902](https://github.com/IBM/ibmi-mcp-server/commit/8ba6902ea780a2e4d7ac67b902186a17aaf9ae84))

* **Documentation Site Links**: Add links to documentation site in README ([76b0ceb](https://github.com/IBM/ibmi-mcp-server/commit/76b0ceb2b9f91a4d325446de076c1a47a272446e))

* **README Improvements**: Multiple formatting and content improvements
  - Improve formatting for server start command ([b215d62](https://github.com/IBM/ibmi-mcp-server/commit/b215d623d65f6bd0bd71f18d6e1642e04f7886de))
  - Fix markdown formatting issues ([1cb70c5](https://github.com/IBM/ibmi-mcp-server/commit/1cb70c58f2a5f1cb7c5a79ea423b93578a11bb43))
  - Update transport settings and logging configuration guidance ([c0b8e57](https://github.com/IBM/ibmi-mcp-server/commit/c0b8e5741b6cf00554601ef8c4c82609b0eccf99))
  - Improve quick start instructions and toolset command examples ([c1baffd](https://github.com/IBM/ibmi-mcp-server/commit/c1baffdab91d371743a7cbaf90a63b603f7bb4ac))
  - Include documentation on using default toolsets ([b45f436](https://github.com/IBM/ibmi-mcp-server/commit/b45f436582c98c8d15882a6f631c91e9237549bb))

### Bug Fixes

* **Logging Configuration**: Fix logging configuration and directory management ([#84](https://github.com/IBM/ibmi-mcp-server/issues/84)) ([2bcaa1f](https://github.com/IBM/ibmi-mcp-server/commit/2bcaa1f07289fb6447a3c070481cc842d2e4546b))
  - Update logging documentation for clarity on log levels and directory configurations
  - Modify logger initialization to support reinitialization based on CLI arguments
  - Improve directory handling for logs with home directory expansion support (~/)
  - Add validation for log directory paths

### Chores

* **Dependency Management**: Optimize dependency classification for production builds ([#75](https://github.com/IBM/ibmi-mcp-server/issues/75)) ([5dd16b3](https://github.com/IBM/ibmi-mcp-server/commit/5dd16b3b68fe774662714f9fe4a4c55de24e3eb5))
  - Move glob from devDependencies to production dependencies
  - Move vite to devDependencies for cleaner production builds
  - Update Dockerfile to copy only production dependencies during image build

* **Developer Tools**: Add script to list pull requests and categorize commits by conventional type ([0447f1d](https://github.com/IBM/ibmi-mcp-server/commit/0447f1dd8adfd3a4f7992e108d1dc21c57d816d4))
  - Facilitate release management and changelog generation
  - Support analysis of commits between version tags

* **Issue Templates**: Update and streamline GitHub issue templates ([9e37c05](https://github.com/IBM/ibmi-mcp-server/commit/9e37c0597c2a4c6c6db5b5860e1fece4b3e1f0d1), [1fdaf63](https://github.com/IBM/ibmi-mcp-server/commit/1fdaf63386cfc4f1be8dc1f8f814fb25d84f431d))
  - Remove outdated templates for bug reports, feature requests, and SQL tool requests
  - Update remaining templates for current project structure


### [0.1.2](https://github.com/IBM/ibmi-mcp-server/compare/v0.1.1...v0.1.2) (2025-12-11)

## 0.1.1 (2025-12-11)

### Initial Release

First public release of the IBM i MCP Server - a Model Context Protocol server for IBM i database operations and AI agent workflows.

### Features

#### Core Database Integration
* **Mapepire Connector**: Integration with IBM i database via Mapepire for secure, efficient SQL execution
* **Execute SQL Tool**: Dynamic SQL execution against IBM i databases with comprehensive parameter handling
* **YAML Tool Configuration**: Support for YAML-based SQL tool definitions with parameter validation
* **Connection Pooling**: Efficient connection management for IBM i database access

#### Authentication & Security
* **IBM i HTTP Authentication**: Encrypted authentication handshake for secure IBM i connections
* **Token Management**: Secure token-based authentication with automatic renewal
* **Multiple Auth Modes**: Support for JWT and OAuth 2.1 authentication strategies
* **Security Tools**: IBM i system security operations and configuration tools

#### Agent Frameworks & Integrations
* **Google ADK Integration**: Support for Google Agent Development Kit workflows
* **Agno Agent Examples**: Pre-configured examples for Agno agent framework
* **LangChain Support**: Comprehensive integration with LangChain agents framework
* **Agent Configuration**: Unified AgentRunConfig for consistent agent setup

#### MCP Client Support
* **Stdio Client**: Example stdio client implementation for MCP server interaction
* **Client Examples**: Multiple client configuration examples and quickstart guides
* **Client Logging**: Support for client-side logging and setLevel requests

#### Configuration & Environment
* **MCP_SERVER_CONFIG Support**: Enhanced .env loading with MCP_SERVER_CONFIG environment variable
* **Flexible Configuration**: Schema-based environment variable validation with string-to-boolean conversion
* **Bob MCP Configuration**: Tool builder instructions and configuration examples

#### Documentation
* **Comprehensive Guides**: Detailed documentation for setup, configuration, and usage
* **API Documentation**: Complete API reference with examples
* **Agent Examples**: Multiple agent implementation examples and patterns
* **Mint Documentation**: Integration with Mintlify for enhanced documentation experience

#### Developer Tools
* **CLI Tools**: MCP command-line tools for server management
* **Dependabot**: Automated dependency updates configured
* **Release Automation**: Standardized release process with semantic versioning

### Bug Fixes
* Update OpenTelemetry dependencies and reorganize package structure
* Add missing dotenv dependency for access token script
* Remove duplicate security checks in system library tools
* Update path references from prebuiltconfigs to tools
* Add error handling for JSON parsing in MCP client
* Fix logger warnings and test assertions
* Fix server deployment issues on Power systems

### Chores
* Update package name to @ibm/ibmi-mcp-server
* Configure GitHub Actions for npm publishing
* Add comprehensive testing infrastructure
* Update dependencies and development tooling
