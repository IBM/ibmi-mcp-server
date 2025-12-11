# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

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
