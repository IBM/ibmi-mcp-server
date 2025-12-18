# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

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
