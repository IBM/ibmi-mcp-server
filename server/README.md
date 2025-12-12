# IBM i MCP Server

The Model Context Protocol (MCP) server for IBM i systems.

## ⚡ Quickstart

### 1. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/IBM/ibmi-mcp-server.git
cd ibmi-mcp-server/
npm install
```

### 2. Build the Project

```bash
npm run build
# Or use 'npm run rebuild' for a clean install
```

### 3. Create Server .env File

```bash
cp .env.example .env
```

Fill out the Db2 for i connection details in the `.env` file:

```bash
# IBM i DB2 for i Connection Settings
# Required for YAML SQL tools to connect to IBM i systems
DB2i_HOST=
DB2i_USER=
DB2i_PASS=
DB2i_PORT=8076
DB2i_IGNORE_UNAUTHORIZED=true
```


### 4. Running the Server

Once built, you can start the server in different transport modes: `http` or `stdio`. 

- **Via Stdio (Default):**
  ```bash
  npx ibmi-mcp-server --transport stdio --tools ./tools
  ```
- **Via Streamable HTTP:**

  ```bash
  npx ibmi-mcp-server --transport http --tools ./tools
  ```

  > By Default, the server registers SQL tools stored in the `tools` directory. This path is set in the `.env` file (`TOOLS_YAML_PATH`). You can override the SQL tools path using the CLI

### 5. Run Example Agent

Make sure that the server is running in `http` mode:

```bash
npx ibmi-mcp-server --transport http --tools ./tools
```

#### Run the Example Scripts:
In another terminal, navigate to the `client/` directory and follow the setup instructions in the [README](client/README.md).


Run an example MCP Client script to list available tools:

```bash
cd client/
uv run mcp_client.py
```

List Configured tool annotations and server resources:

```bash
cd client/

# See a list of configured tools:
uv run list_tool_annotations.py

# see a list of server resources:
uv run list_toolset_resources.py
```

> Note: `list_tool_annotations.py` and `list_toolset_resources.py` DO NOT require and OpenAI API Key 

#### Run the example Agent:

```bash
cd client/
export OPENAI_API_KEY=your_open_ai_key
uv run agent.py -p "What is my system status?"
```

### 6. Running Tests

This template uses [Vitest](https://vitest.dev/) for testing, with a strong emphasis on **integration testing** to ensure all components work together correctly.

- **Run all tests once:**
  ```bash
  npm test
  ```
- **Run tests in watch mode:**
  ```bash
  npm run test:watch
  ```
- **Run tests and generate a coverage report:**
  ```bash
  npm run test:coverage
  ```

  ## Architecture Overview
  
  This template is built on a set of architectural principles to ensure modularity, testability, and operational clarity.
  
  - **Core Server (`src/mcp-server/server.ts`)**: The central point where tools and resources are registered. It uses a `ManagedMcpServer` wrapper to provide enhanced introspection capabilities. It acts the same way as the native McpServer, but with additional features like introspection and enhanced error handling.
  - **Transports (`src/mcp-server/transports/`)**: The transport layer connects the core server to the outside world. It supports both `stdio` for direct process communication and a streamable **Hono**-based `http` server.
  - **"Logic Throws, Handler Catches"**: This is the immutable cornerstone of our error-handling strategy.
    - **Core Logic (`logic.ts`)**: This layer is responsible for pure, self-contained business logic. It **throws** a structured `McpError` on any failure.
    - **Handlers (`registration.ts`)**: This layer interfaces with the server, invokes the core logic, and **catches** any errors. It is the exclusive location where errors are processed and formatted into a final response.
  - **Structured, Traceable Operations**: Every operation is traced from initiation to completion via a `RequestContext` that is passed through the entire call stack, ensuring comprehensive and structured logging.
  
  ### Key Features
  
  | Feature Area                | Description                                                                                                                                          | Key Components / Location                                            |
  | :-------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------- |
  | **🔌 MCP Server**           | A functional server with example tools and resources. Supports `stdio` and a **Streamable HTTP** transport built with [**Hono**](https://hono.dev/). | `src/mcp-server/`, `src/mcp-server/transports/`                      |
  | **🔭 Observability**        | Built-in **OpenTelemetry** for distributed tracing and metrics. Auto-instrumentation for core modules and custom tracing for all tool executions.    | `src/utils/telemetry/`                                               |
  | **🚀 Production Utilities** | Logging, Error Handling, ID Generation, Rate Limiting, Request Context tracking, Input Sanitization.                                                 | `src/utils/`                                                         |
  | **🔒 Type Safety/Security** | Strong type checking via TypeScript & Zod validation. Built-in security utilities (sanitization, auth middleware for HTTP).                          | Throughout, `src/utils/security/`, `src/mcp-server/transports/auth/` |
  | **⚙️ Error Handling**       | Consistent error categorization (`BaseErrorCode`), detailed logging, centralized handling (`ErrorHandler`).                                          | `src/utils/internal/errorHandler.ts`, `src/types-global/`            |
  | **📚 Documentation**        | Comprehensive `README.md`, structured JSDoc comments, API references.                                                                                | `README.md`, Codebase, `tsdoc.json`, `docs/api-references/`          |
  | **🕵️ Interaction Logging**  | Captures raw requests and responses for all external LLM provider interactions to a dedicated `interactions.log` file for full traceability.         | `src/utils/internal/logger.ts`                                       |
  | **🤖 Agent Ready**          | Includes a [.clinerules](./.clinerules/clinerules.md) developer cheatsheet tailored for LLM coding agents.                                           | `.clinerules/`                                                       |
  | **🛠️ Utility Scripts**      | Scripts for cleaning builds, setting executable permissions, generating directory trees, and fetching OpenAPI specs.                                 | `scripts/`                                                           |
  | **🧩 Services**             | Reusable modules for LLM (OpenRouter) and data storage (DuckDB) integration, with examples.                                                          | `src/services/`, `src/storage/duckdbExample.ts`                      |
  | **🧪 Integration Testing**  | Integrated with Vitest for fast and reliable integration testing. Includes example tests for core logic and a coverage reporter.                     | `vitest.config.ts`, `tests/`                                         |
  | **⏱️ Performance Metrics**  | Built-in utility to automatically measure and log the execution time and payload size of every tool call.                                            | `src/utils/internal/performance.ts`                                  |
  
  
  ### Project Structure
  
  - **`src/mcp-server/`**: Contains the core MCP server, tools, resources, and transport handlers.
  - **`src/ibmi-mcp-server/`**: IBM i specific implementations and integrations.
  - **`src/config/`**: Handles loading and validation of environment variables.
  - **`src/services/`**: Reusable modules for integrating with external services (DuckDB, OpenRouter).
  - **`src/types-global/`**: Defines shared TypeScript interfaces and type definitions.
  - **`src/utils/`**: Core utilities (logging, error handling, security, etc.).
  - **`src/index.ts`**: The main entry point that initializes and starts the server.


### Available Scripts

- `npm run build` - Build the server
- `npm run rebuild` - Clean and rebuild
- `npm run start:http` - Start in HTTP mode
- `npm run start:stdio` - Start in stdio mode
- `npm test` - Run tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage
- `npm run lint` - Lint code
- `npm run format` - Format code with Prettier
- `npm run validate` - Validate tool configurations

### Architecture

See [CLAUDE.md](../CLAUDE.md) for architectural standards and development guidelines.

## Monorepo Structure

This server is part of a monorepo:

- `../tools/` - SQL tool YAML configurations
- `../agents/` - Agent implementations and examples
