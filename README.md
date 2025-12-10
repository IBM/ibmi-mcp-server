<div align="center">

# ibmi-mcp-server (⚠️ Under Active Development)

**MCP server for IBM i**

[![TypeScript](https://img.shields.io/badge/TypeScript-^5.8.3-blue?style=flat-square)](https://www.typescriptlang.org/)
[![Model Context Protocol SDK](https://img.shields.io/badge/MCP%20SDK-^1.17.1-green?style=flat-square)](https://github.com/modelcontextprotocol/typescript-sdk)
[![MCP Spec Version](https://img.shields.io/badge/MCP%20Spec-2025--06--18-lightgrey?style=flat-square)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/changelog.mdx)
[![Version](https://img.shields.io/badge/Version-1.9.1-blue?style=flat-square)](./CHANGELOG.md)
[![Coverage](https://img.shields.io/badge/Coverage-64.67%25-brightgreen?style=flat-square)](./vitest.config.ts)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Stable-green?style=flat-square)](https://github.com/IBM/ibmi-mcp-server.git)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/IBM/ibmi-mcp-server)

**📚 [Documentation](https://ibm-d95bab6e.mintlify.app/) | ⚠️ Docs are under active development**
![alt text](docs/images/logo-2.png)
</div>

---


## 📁 Repository Structure

Here is an overview of the repository structure:

```
ibmi-mcp-server/
├── server/          ← MCP server implementation (main package)
├── tools/           ← SQL tool YAML configurations
├── agents/          ← Agent implementations and examples
└── apps/            ← Deployment configurations (Docker, Gateway, n8n)
```

### Quick Navigation

- **[Server Documentation](./server/README.md)** - MCP server setup, development, and API
- **[Tools Documentation](./tools/README.md)** - SQL tool configuration guide
- **[Agents Documentation](./agents/README.md)** - Agent development and examples
- **[Deployment Guide](./apps/README.md)** - Docker, Gateway, and n8n setup

---
<details>
<summary><strong>📋 Table of Contents</strong></summary>

- [ibmi-mcp-server (⚠️ Under Active Development)](#ibmi-mcp-server-️-under-active-development)
  - [📁 Repository Structure](#-repository-structure)
    - [Quick Navigation](#quick-navigation)
  - [📡 Setup Mapepire](#-setup-mapepire)
    - [What is Mapepire?](#what-is-mapepire)
    - [Why Mapepire Enables AI and MCP Workloads](#why-mapepire-enables-ai-and-mcp-workloads)
    - [Installation](#installation)
  - [⚡ Quickstart](#-quickstart)
    - [1. Installation](#1-installation)
    - [2. Build the Project](#2-build-the-project)
    - [3. Create Server .env File](#3-create-server-env-file)
    - [4. Running the Server](#4-running-the-server)
    - [5. Run Example Agent](#5-run-example-agent)
      - [Run the Example Scripts:](#run-the-example-scripts)
      - [Run the example Agent:](#run-the-example-agent)
    - [6. Running Tests](#6-running-tests)
  - [🔌 Installing in MCP Clients](#-installing-in-mcp-clients)
    - [Prerequisites: Local Installation](#prerequisites-local-installation)
    - [Remote Server Setup](#remote-server-setup)
    - [Client Configurations](#client-configurations)
    - [Troubleshooting](#troubleshooting)
  - [🤖 IBM i Agents](#-ibm-i-agents)
    - [Key Features](#key-features)
    - [Getting Started](#getting-started)
  - [⚙️ Configuration](#️-configuration)
    - [General Authentication](#general-authentication)
    - [JWT Authentication](#jwt-authentication)
    - [OAuth Authentication](#oauth-authentication)
    - [IBM i HTTP Authentication](#ibm-i-http-authentication)
    - [Tool Loading](#tool-loading)
    - [Configuration Merging](#configuration-merging)
    - [OpenRouter](#openrouter)
    - [LLM Defaults](#llm-defaults)
    - [Configuration Best Practices](#configuration-best-practices)
  - [🔐 IBM i HTTP Authentication (Beta)](#-ibm-i-http-authentication-beta)
    - [Authentication Flow](#authentication-flow)
    - [Configuration](#configuration)
    - [Getting Access Tokens](#getting-access-tokens)
      - [Option 1: Using the Token Script (Recommended)](#option-1-using-the-token-script-recommended)
      - [Sequence Overview](#sequence-overview)
    - [Client Integration](#client-integration)
    - [Security Considerations](#security-considerations)
    - [Authentication Endpoints](#authentication-endpoints)
  - [🧩 SQL Tool Configuration](#-sql-tool-configuration)
    - [Sources](#sources)
    - [Tools](#tools)
    - [Toolsets](#toolsets)
  - [🚀 Running the Server (Development)](#-running-the-server-development)
    - [Transport Modes](#transport-modes)
      - [HTTP Transport (Recommended for Development)](#http-transport-recommended-for-development)
      - [Stdio Transport (for CLI tools and MCP Inspector)](#stdio-transport-for-cli-tools-and-mcp-inspector)
    - [Session Modes (HTTP Only)](#session-modes-http-only)
    - [CLI Options](#cli-options)
    - [Common Development Scenarios](#common-development-scenarios)
    - [Development Tips](#development-tips)
    - [Troubleshooting](#troubleshooting-1)
  - [🕵️‍♂️ MCP Inspector](#️️-mcp-inspector)
  - [Docker \& Podman Deployment](#docker--podman-deployment)
    - [Prerequisites](#prerequisites)
      - [Docker](#docker)
      - [Podman (Alternative to Docker)](#podman-alternative-to-docker)
      - [Build MCP Gateway Image](#build-mcp-gateway-image)
      - [Configure MCP environment](#configure-mcp-environment)
    - [Quick Start with Docker](#quick-start-with-docker)
    - [Quick Start with Podman](#quick-start-with-podman)
    - [Container Architecture](#container-architecture)
    - [🔧 Service Management](#-service-management)
      - [Start Services](#start-services)
      - [Stop Services](#stop-services)
      - [View Logs](#view-logs)
      - [Rebuild Services](#rebuild-services)
    - [MCP Gateway UI:](#mcp-gateway-ui)
    - [Virtual Server Catalog Demo (Comming soon!!)](#virtual-server-catalog-demo-comming-soon)
  - [Architecture Overview](#architecture-overview)
    - [Key Features](#key-features-1)
    - [Project Structure](#project-structure)
    - [Extending the System](#extending-the-system)
    - [The "Logic Throws, Handler Catches" Pattern](#the-logic-throws-handler-catches-pattern)
  - [📜 License](#-license)

</details>

---

## 📡 Setup Mapepire

**Before you can use the ibmi-mcp-server, you must install and configure Mapepire on your IBM i system.**

### What is Mapepire?

[Mapepire](https://mapepire-ibmi.github.io/) is a modern, high-performance database server for IBM i that provides SQL query execution capabilities over WebSocket connections. It acts as a gateway between modern application architectures (like MCP servers, AI agents, and REST APIs) and IBM i's Db2 for i database.

### Why Mapepire Enables AI and MCP Workloads

Traditional IBM i database access methods (ODBC, JDBC) don't align well with modern AI and MCP architectures that require:

- **Fast, lightweight connections**: AI agents make frequent, short-lived database queries
- **WebSocket support**: Enables real-time, bidirectional communication for streaming results
- **Modern JSON-based protocols**: Simplifies integration with TypeScript/JavaScript ecosystems
- **Low-latency responses**: Essential for interactive AI conversations and tool executions

Mapepire bridges this gap by providing a modern, WebSocket-based SQL query interface that's optimized for the request/response patterns of AI agents and MCP tools.

### Installation

**Quick Install (IBM i SSH Session):**

```bash
# 1. Install Mapepire using yum
yum install mapepire-server

# 2. Install Service Commander (if not already installed)
yum install service-commander

# 3. Start Mapepire service
sc start mapepire
```

**📚 Full Documentation:** [Mapepire System Administrator Guide](https://mapepire-ibmi.github.io/guides/sysadmin/)

> **Important Notes:**
> - By default, Mapepire runs on port `8076`. You'll need this port number when configuring the `DB2i_PORT` variable in your `.env` file.
> - Ensure your IBM i firewall allows inbound connections on port 8076
> - For production deployments, configure SSL/TLS certificates (see official guide)

---

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

> **📖 Configuration Guide:** See the complete [Configuration](#⚙️-configuration) section for all available settings, including [IBM i Database Connection](#🗄️-ibm-i-database-connection), [Authentication](#🔐-authentication--authorization), [HTTP Transport](#🌐-http-transport-settings), and more.

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

## 🔌 Installing in MCP Clients

This server can be integrated into any MCP-compatible client using either **local** (stdio) or **remote** (HTTP) connections.

### Prerequisites: Local Installation

For local development, install the server globally using `npm link`:

```bash
# From the ibmi-mcp-server directory
npm install
npm run build
npm link
```

This makes the `ibmi-mcp-server` command available globally on your machine. After linking, you can use `npx ibmi-mcp-server` in any client configuration.

> **Note:** `TOOLS_YAML_PATH` must be an **absolute path** to your tools configuration directory (e.g., `/full/path/to/tools`).

### Remote Server Setup

For HTTP remote connections, you need to:

1. **Start the server with IBM i authentication enabled:**

   ```bash
   # Ensure your .env has these settings:
   MCP_AUTH_MODE=ibmi
   IBMI_HTTP_AUTH_ENABLED=true
   IBMI_AUTH_ALLOW_HTTP=true  # For development only!

   npm run start:http
   ```

2. **Obtain an access token:**

   ```bash
   # Use the token script to authenticate
   node get-access-token.js --verbose

   # Or set it directly in your environment
   export IBMI_MCP_ACCESS_TOKEN="your-token-here"
   ```

   See [IBM i HTTP Authentication](#ibm-i-http-authentication-beta) for detailed authentication setup.

3. **Configure your client** with the server URL and Bearer token (examples below).

> **⚠️ Production Note:** Replace `http://localhost:3010` with your production endpoint URL and ensure HTTPS is enabled (`IBMI_AUTH_ALLOW_HTTP=false`).

---

### Client Configurations

<details>
<summary><strong>Claude Code</strong></summary>

Claude Code supports both local (stdio) and remote (HTTP) MCP server connections. You can configure servers using the CLI or by editing `.mcp.json` directly.

#### Option 1: Local Stdio Server (Recommended)

**Using CLI:**
```bash
# Add local stdio server
claude mcp add ibmi-mcp \
  --env DB2i_HOST=your-ibmi-host.com \
  --env DB2i_USER=your-username \
  --env DB2i_PASS=your-password \
  --env DB2i_PORT=8076 \
  --env MCP_TRANSPORT_TYPE=stdio \
  -- npx ibmi-mcp-server --tools /absolute/path/to/tools
```

**Using `.mcp.json`:**
```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "command": "npx",
      "args": ["ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio",
        "NODE_OPTIONS": "--no-deprecation"
      }
    }
  }
}
```

#### Option 2: Remote HTTP Server

**Using CLI:**
```bash
# Add remote HTTP server with authentication
claude mcp add --transport http ibmi-mcp http://localhost:3010/mcp \
  --header "Authorization: Bearer YOUR_ACCESS_TOKEN_HERE"
```

**Using `.mcp.json`:**
```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "url": "http://localhost:3010/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_TOKEN_HERE"
      }
    }
  }
}
```

#### Environment Variable Expansion

Claude Code supports environment variable expansion in `.mcp.json` files, allowing you to keep credentials secure:

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "command": "npx",
      "args": ["ibmi-mcp-server", "--tools", "${IBMI_TOOLS_PATH}"],
      "env": {
        "DB2i_HOST": "${DB2i_HOST}",
        "DB2i_USER": "${DB2i_USER}",
        "DB2i_PASS": "${DB2i_PASS}",
        "DB2i_PORT": "${DB2i_PORT:-8076}",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

**Supported syntax:**
- `${VAR}` - Expands to the value of environment variable `VAR`
- `${VAR:-default}` - Expands to `VAR` if set, otherwise uses `default`

#### Managing Servers

```bash
# List configured servers
claude mcp list

# Get server details
claude mcp get ibmi-mcp

# Remove a server
claude mcp remove ibmi-mcp

# Check server status in Claude Code
/mcp
```

> 📖 [Claude Code MCP Documentation](https://docs.claude.com/en/docs/claude-code/mcp)

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

#### Local (Stdio)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "command": "npx",
      "args": ["ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

#### Remote (HTTP)

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "url": "http://localhost:3010/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_TOKEN_HERE"
      }
    }
  }
}
```

> 📖 [Claude Desktop MCP Setup](https://modelcontextprotocol.io/quickstart/user)

</details>

<details>
<summary><strong>VSCode</strong></summary>

VSCode supports MCP servers through Copilot Chat. You can configure servers at the user or workspace level using configuration files or the CLI.

**Prerequisites:** Ensure [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) is installed and enabled.

#### Configuration File Locations

- **Workspace:** `.vscode/mcp.json` (shared with team via version control)
- **User:** `mcp.json` in your user profile directory
  - macOS/Linux: `~/.config/Code/User/globalStorage/modelcontextprotocol.mcp/mcp.json`
  - Windows: `%APPDATA%\Code\User\globalStorage\modelcontextprotocol.mcp\mcp.json`

#### Option 1: Local Stdio Server

**Using CLI:**
```bash
# Add local stdio server
code --add-mcp '{
  "name": "ibmiMcp",
  "type": "stdio",
  "command": "npx",
  "args": ["ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
  "env": {
    "DB2i_HOST": "your-ibmi-host.com",
    "DB2i_USER": "your-username",
    "DB2i_PASS": "your-password",
    "DB2i_PORT": "8076",
    "MCP_TRANSPORT_TYPE": "stdio"
  }
}'
```

**Using `mcp.json`:**
```json
{
  "servers": {
    "ibmiMcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

#### Option 2: Remote HTTP Server

**Using CLI:**
```bash
# Add remote HTTP server
code --add-mcp '{
  "name": "ibmiMcp",
  "type": "http",
  "url": "http://localhost:3010/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_ACCESS_TOKEN_HERE"
  }
}'
```

**Using `mcp.json`:**
```json
{
  "servers": {
    "ibmiMcp": {
      "type": "http",
      "url": "http://localhost:3010/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_TOKEN_HERE"
      }
    }
  }
}
```

#### Secure Credentials with Input Variables

VSCode supports input variables to avoid hardcoding sensitive credentials:

```json
{
  "inputs": [
    {
      "id": "db2iHost",
      "type": "promptString",
      "description": "IBM i DB2 host address"
    },
    {
      "id": "db2iUser",
      "type": "promptString",
      "description": "IBM i username"
    },
    {
      "id": "db2iPass",
      "type": "promptString",
      "description": "IBM i password",
      "password": true
    }
  ],
  "servers": {
    "ibmiMcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "${input:db2iHost}",
        "DB2i_USER": "${input:db2iUser}",
        "DB2i_PASS": "${input:db2iPass}",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

VSCode will prompt for these values when the server starts, keeping credentials secure.

#### Managing Servers

- **View servers:** Check the Copilot Chat view in the Activity Bar
- **Restart server:** Use Command Palette (`Cmd/Ctrl+Shift+P`) → "MCP: Restart Server"
- **Disable server:** Remove from `mcp.json` or disable in settings

> 📖 [VSCode MCP Documentation](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)

</details>

<details>
<summary><strong>Cursor</strong></summary>

#### Local (Stdio)

Add to Cursor settings or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "command": "npx",
      "args": ["ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

#### Remote (HTTP)

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "url": "http://localhost:3010/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_TOKEN_HERE"
      }
    }
  }
}
```

> 📖 [Cursor MCP Documentation](https://docs.cursor.com/context/model-context-protocol)

</details>

<details>
<summary><strong>Windsurf</strong></summary>

#### Local (Stdio)

Add to Windsurf configuration:

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "command": "npx",
      "args": ["ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

#### Remote (HTTP)

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "url": "http://localhost:3010/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_TOKEN_HERE"
      }
    }
  }
}
```

> 📖 [Windsurf MCP Documentation](https://docs.windsurf.com/windsurf/cascade/mcp)

</details>

<details>
<summary><strong>Roo Code</strong></summary>

#### Local (Stdio)

Configure in Roo Code settings:

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "command": "npx",
      "args": ["ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

#### Remote (HTTP)

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "url": "http://localhost:3010/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_TOKEN_HERE"
      }
    }
  }
}
```

> 📖 [Roo Code MCP Documentation](https://docs.roocode.com/features/mcp/using-mcp-in-roo)

</details>

<details>
<summary><strong>LM Studio</strong></summary>

#### Local (Stdio)

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "command": "npx",
      "args": ["ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio",
        "NODE_OPTIONS": "--no-deprecation"
      }
    }
  }
}
```

#### Remote (HTTP)

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "url": "http://localhost:3010/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_TOKEN_HERE"
      }
    }
  }
}
```

> 📖 [LM Studio MCP Support](https://lmstudio.ai/blog/lmstudio-v0.3.17)

</details>

<details>
<summary><strong>OpenCode</strong></summary>

#### Local (Stdio)

Add local MCP servers using "type": "local" within the MCP object. Multiple MCP servers can be added. The key string for each server can be any arbitrary name.

**opencode.json**:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ibmi-mcp": {
      "type": "local",
      "enabled": true,
      "command": ["npx", "ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
      "environment": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio"
      },
      "enabled": true
    }
  }
}
```

You can also disable a server by setting enabled to false. This is useful if you want to temporarily disable a server without removing it from your config.

#### Remote (HTTP)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ibmi-mcp": {
      "type": "remote",
      "enabled": true,
      "url": "http://localhost:3010/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_TOKEN_HERE"
      }
    }
  }
}
```

> 📖 [OpenCode MCP Documentation](https://opencode.ai/docs/mcp-servers)

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

See [Gemini CLI Configuration](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html) for details.
1.  Open the Gemini CLI settings file. The location is `~/.gemini/settings.json` (where `~` is your home directory).
2.  Add the following to the `mcpServers` object in your `settings.json` file:

#### Local (Stdio)

Configure in Gemini CLI settings:

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "command": "npx",
      "args": ["ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

#### Remote (HTTP)

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "url": "http://localhost:3010/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_TOKEN_HERE"
      }
    }
  }
}
```

> 📖 [Gemini CLI MCP Documentation](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html)

</details>

<details>
<summary><strong>Cline</strong></summary>

Cline supports MCP servers through both the marketplace and manual configuration.

**Prerequisites:** Ensure [Cline](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev) is installed in VSCode.

#### Option 1: Manual Configuration

**For Local (Stdio) Server:**

1. Open **Cline**
2. Click the hamburger menu icon (☰) → **MCP Servers**
3. Choose **Local Servers** tab
4. Click **Edit Configuration**
5. Add the configuration:

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "command": "npx",
      "args": ["ibmi-mcp-server", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

**For Remote (HTTP) Server:**

1. Open **Cline**
2. Click the hamburger menu icon (☰) → **MCP Servers**
3. Choose **Remote Servers** tab
4. Click **Edit Configuration**
5. Add the configuration:

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "url": "http://localhost:3010/mcp",
      "type": "streamableHttp",
      "headers": {
        "Authorization": "Bearer YOUR_ACCESS_TOKEN_HERE"
      }
    }
  }
}
```

> 📖 [Cline MCP Documentation](https://docs.cline.bot/mcp/mcp-overview#mcp-overview) | [Cline MCP Marketplace](https://cline.bot/mcp-marketplace)

</details>

<details>
<summary><strong>Python Clients (Agno, Official MCP SDK)</strong></summary>

#### Remote (HTTP) with Agno

```python
import asyncio
import os
from agno.agent import Agent
from agno.tools.mcp import MCPTools, StreamableHTTPClientParams

# Get access token from environment
token = os.environ.get('IBMI_MCP_ACCESS_TOKEN')
if not token:
    raise ValueError("IBMI_MCP_ACCESS_TOKEN not set")

url = "http://localhost:3010/mcp"
server_params = StreamableHTTPClientParams(
    url=url,
    headers={"Authorization": f"Bearer {token}"}
)

async def main():
    async with MCPTools(
        url=url,
        server_params=server_params,
        transport="streamable-http"
    ) as tools:
        # List available tools
        result = await tools.session.list_tools()
        print(f"Available tools: {[t.name for t in result.tools]}")

        # Create agent
        agent = Agent(
            model="openai:gpt-4o",  # or your preferred model
            tools=[tools],
            name="ibmi-agent",
            show_tool_calls=True
        )

        # Run query
        await agent.aprint_response("What is the system status?")

if __name__ == "__main__":
    asyncio.run(main())
```

#### Remote (HTTP) with Official MCP SDK

```python
import asyncio
import os
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async def main():
    token = os.environ.get('IBMI_MCP_ACCESS_TOKEN')
    if not token:
        raise ValueError("IBMI_MCP_ACCESS_TOKEN not set")

    headers = {"Authorization": f"Bearer {token}"}

    async with streamablehttp_client(
        "http://localhost:3010/mcp",
        headers=headers
    ) as (read_stream, write_stream, _):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()

            # List tools
            tools = await session.list_tools()
            print(f"Tools: {[t.name for t in tools.tools]}")

            # Execute a tool
            result = await session.call_tool("system_status", {})
            print(result)

if __name__ == "__main__":
    asyncio.run(main())
```

> 📖 [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) | [Agno Framework](https://github.com/agno-agi/agno)

</details>

---

### Troubleshooting

**Connection Issues:**
- Verify `npm link` was successful: `which ibmi-mcp-server`
- Check that `TOOLS_YAML_PATH` is an absolute path
- Ensure IBM i credentials are correct

**MCP Server Errors:**
If using `npx ibmi-mcp-server` does not work, use node directly:

```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/ibmi-mcp-server/server/dist/index.js", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
        "MCP_TRANSPORT_TYPE": "stdio",
        "NODE_OPTIONS": "--no-deprecation"
      }
    }
  }
}
```

**Authentication Failures (Remote):**
- Confirm server is running with `IBMI_HTTP_AUTH_ENABLED=true`
- Verify token is valid: `echo $IBMI_MCP_ACCESS_TOKEN`
- Check server logs for authentication errors

**Tool Loading Errors:**
- Validate YAML configuration: `npm run validate -- --config tools`
- Check file permissions on tools directory
- Review server startup logs for parsing errors

## 🤖 IBM i Agents

IBM i Agents are specialized components designed to interact with the IBM i system, providing capabilities such as monitoring, management, and automation.

### Key Features
- **Integration with IBM i:** Seamless integration with IBM i system APIs and tools.
- **Modular Architecture:** Easily extendable and customizable to fit specific use cases.
- **Real-time Monitoring:** Continuous monitoring of system performance and health.

### Getting Started

Navigate to the `agents` directory and follow the setup instructions in the [README](./agents/README.md). This includes details on configuration, running agents, and examples. Most agent examples require the MCP server to be running in HTTP mode. Read the docs for each agent example for details.

  



## ⚙️ Configuration

The server is configured using environment variables, typically set in a `.env` file at the project root. Configuration is organized into logical groups for easier management.

**Quick Start:**
```bash
cp .env.example .env
code .env  # Edit with your settings
```

---

<details>
<summary><strong>🖥️ MCP Server Settings</strong></summary>

Core server configuration including server identity, transport mode, and logging.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_SERVER_NAME` | Server name identifier for MCP protocol | Package name from `package.json` | No |
| `MCP_SERVER_VERSION` | Server version for MCP protocol | Version from `package.json` | No |
| `MCP_TRANSPORT_TYPE` | Transport protocol: `stdio` (local) or `http` (remote) | `stdio` | No |
| `MCP_LOG_LEVEL` | Logging verbosity: `error`, `warn`, `info`, `debug` | `debug` | No |
| `LOGS_DIR` | Directory for log files (relative to project root) | `logs` | No |
| `NODE_ENV` | Node environment: `development`, `production`, `test` | `development` | No |

**Examples:**
```bash
# Development with verbose logging
MCP_SERVER_NAME=ibmi-mcp-dev
MCP_TRANSPORT_TYPE=http
MCP_LOG_LEVEL=debug
NODE_ENV=development

# Production with minimal logging
MCP_SERVER_NAME=ibmi-mcp-prod
MCP_TRANSPORT_TYPE=stdio
MCP_LOG_LEVEL=warn
NODE_ENV=production
```

</details>

<details>
<summary><strong>🌐 HTTP Transport Settings</strong></summary>

Configuration for HTTP transport mode, including network settings, session management, and CORS.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_HTTP_PORT` | HTTP server port | `3010` | No |
| `MCP_HTTP_HOST` | HTTP server bind address | `127.0.0.1` | No |
| `MCP_HTTP_ENDPOINT_PATH` | MCP endpoint path | `/mcp` | No |
| `MCP_SESSION_MODE` | Session handling: `stateless`, `stateful`, or `auto` | `auto` | No |
| `MCP_STATEFUL_SESSION_STALE_TIMEOUT_MS` | Timeout for idle stateful sessions (milliseconds) | `1800000` (30 min) | No |
| `MCP_HTTP_MAX_PORT_RETRIES` | Max attempts to find available port if default is in use | `15` | No |
| `MCP_HTTP_PORT_RETRY_DELAY_MS` | Delay between port retry attempts (milliseconds) | `50` | No |
| `MCP_ALLOWED_ORIGINS` | Comma-separated CORS allowed origins | None (all origins blocked) | No |

**Session Modes:**
- **`auto`**: Automatically detects client capabilities and uses the best session mode
- **`stateful`**: Maintains persistent sessions with connection state (best for long-running interactions)
- **`stateless`**: Each request is independent (best for load balancing and horizontal scaling)

**Examples:**
```bash
# Development server with CORS for local web clients
MCP_HTTP_PORT=3010
MCP_HTTP_HOST=0.0.0.0  # Listen on all interfaces
MCP_SESSION_MODE=auto
MCP_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173

# Production server with strict security
MCP_HTTP_PORT=443
MCP_HTTP_HOST=0.0.0.0
MCP_SESSION_MODE=stateful
MCP_ALLOWED_ORIGINS=https://app.example.com,https://dashboard.example.com
MCP_STATEFUL_SESSION_STALE_TIMEOUT_MS=3600000  # 1 hour
```

</details>

<details>
<summary><strong>🔐 Authentication & Authorization</strong></summary>

Security configuration for protecting the MCP server and authenticating clients.

### General Authentication

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_AUTH_MODE` | Authentication mode: `none`, `jwt`, `oauth`, `ibmi` | `none` | No |

### JWT Authentication

Required when `MCP_AUTH_MODE=jwt`.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_AUTH_SECRET_KEY` | Secret key for signing/verifying JWT tokens (min 32 characters) | None | ✅ Yes (for JWT mode) |

### OAuth Authentication

Required when `MCP_AUTH_MODE=oauth`.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `OAUTH_ISSUER_URL` | OAuth authorization server issuer URL | None | ✅ Yes (for OAuth mode) |
| `OAUTH_JWKS_URI` | OAuth JWKS endpoint for public key verification | None | No |
| `OAUTH_AUDIENCE` | Expected audience identifier for this MCP server | None | ✅ Yes (for OAuth mode) |

### IBM i HTTP Authentication

Required when `MCP_AUTH_MODE=ibmi`. See [IBM i HTTP Authentication](#ibm-i-http-authentication-beta) for detailed setup.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `IBMI_HTTP_AUTH_ENABLED` | Enable IBM i authentication endpoints | `false` | ✅ Yes (for IBM i mode) |
| `IBMI_AUTH_ALLOW_HTTP` | Allow HTTP (non-HTTPS) authentication requests | `false` | No |
| `IBMI_AUTH_TOKEN_EXPIRY_SECONDS` | Token lifetime in seconds | `3600` (1 hour) | No |
| `IBMI_AUTH_CLEANUP_INTERVAL_SECONDS` | How often to clean up expired tokens (seconds) | `300` (5 minutes) | No |
| `IBMI_AUTH_MAX_CONCURRENT_SESSIONS` | Maximum concurrent authenticated sessions | `100` | No |
| `IBMI_AUTH_PRIVATE_KEY_PATH` | Path to RSA private key for encryption | None | ✅ Yes (for IBM i mode) |
| `IBMI_AUTH_PUBLIC_KEY_PATH` | Path to RSA public key for encryption | None | ✅ Yes (for IBM i mode) |
| `IBMI_AUTH_KEY_ID` | Identifier for the RSA keypair | None | ✅ Yes (for IBM i mode) |

**Examples:**
```bash
# No authentication (development only)
MCP_AUTH_MODE=none

# JWT authentication
MCP_AUTH_MODE=jwt
MCP_AUTH_SECRET_KEY="your-very-secret-key-at-least-32-characters-long"

# OAuth authentication
MCP_AUTH_MODE=oauth
OAUTH_ISSUER_URL=https://auth.example.com
OAUTH_AUDIENCE=https://api.example.com/mcp
OAUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json

# IBM i authentication (see docs for keypair generation)
MCP_AUTH_MODE=ibmi
IBMI_HTTP_AUTH_ENABLED=true
IBMI_AUTH_KEY_ID=production
IBMI_AUTH_PRIVATE_KEY_PATH=secrets/private.pem
IBMI_AUTH_PUBLIC_KEY_PATH=secrets/public.pem
IBMI_AUTH_ALLOW_HTTP=false  # HTTPS only in production
IBMI_AUTH_TOKEN_EXPIRY_SECONDS=7200  # 2 hours
```

**⚠️ Security Notes:**
- **Never** use `MCP_AUTH_MODE=none` in production
- **Always** use `IBMI_AUTH_ALLOW_HTTP=false` in production (requires HTTPS)
- Generate strong secret keys (32+ characters) for JWT mode
- Rotate keys regularly for enhanced security

</details>

<details>
<summary><strong>🗄️ IBM i Database Connection</strong></summary>

Configuration for connecting to IBM i Db2 for i databases via Mapepire.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DB2i_HOST` | IBM i system hostname or IP address | None | ✅ Yes (for SQL tools) |
| `DB2i_USER` | IBM i user profile for database connections | None | ✅ Yes (for SQL tools) |
| `DB2i_PASS` | Password for IBM i user profile | None | ✅ Yes (for SQL tools) |
| `DB2i_PORT` | Mapepire daemon/gateway port | `8076` | No |
| `DB2i_IGNORE_UNAUTHORIZED` | Skip TLS certificate verification (for self-signed certs) | `true` | No |

**Connection Flow:**
1. Server connects to Mapepire daemon/gateway at `DB2i_HOST:DB2i_PORT`
2. Authenticates using `DB2i_USER` and `DB2i_PASS`
3. Executes SQL tools through authenticated connection pool

**Examples:**
```bash
# Development connection with self-signed certs
DB2i_HOST=ibmi-dev.example.com
DB2i_USER=DEVUSER
DB2i_PASS=devpassword
DB2i_PORT=8076
DB2i_IGNORE_UNAUTHORIZED=true

# Production connection with verified SSL
DB2i_HOST=ibmi-prod.example.com
DB2i_USER=PRODUSER
DB2i_PASS=strongProductionPassword123
DB2i_PORT=8076
DB2i_IGNORE_UNAUTHORIZED=false  # Require valid SSL cert

# Connecting to Mapepire gateway
DB2i_HOST=mapepire-gateway.example.com
DB2i_USER=APIUSER
DB2i_PASS=apiPassword456
DB2i_PORT=443  # Gateway on HTTPS
DB2i_IGNORE_UNAUTHORIZED=false
```

**⚠️ Security Notes:**
- Store credentials securely (use secrets management in production)
- Use read-only accounts when possible
- Set `DB2i_IGNORE_UNAUTHORIZED=false` with valid SSL certificates in production
- Consider using IBM i authentication mode for per-user connection pooling

</details>

<details>
<summary><strong>🧩 SQL YAML Tool Configuration</strong></summary>

Settings for loading and managing SQL tools defined in YAML configuration files. See [Tools Documentation](./tools/README.md) for YAML tool development.

### Tool Loading

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `TOOLS_YAML_PATH` | Path to YAML tool configurations (file, directory, or glob) | None | No |
| `SELECTED_TOOLSETS` | Comma-separated list of toolsets to load (filters available tools) | None (load all) | No |
| `YAML_AUTO_RELOAD` | Automatically reload tools when YAML files change | `true` | No |

### Configuration Merging

When loading multiple YAML files, these settings control merge behavior:

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `YAML_MERGE_ARRAYS` | Merge arrays from multiple files (`true`) or replace them (`false`) | `true` | No |
| `YAML_ALLOW_DUPLICATE_TOOLS` | Allow duplicate tool names across files | `false` | No |
| `YAML_ALLOW_DUPLICATE_SOURCES` | Allow duplicate source names across files | `false` | No |
| `YAML_VALIDATE_MERGED` | Validate merged configuration before loading tools | `true` | No |

**Path Resolution:**
- **File**: `TOOLS_YAML_PATH=tools/performance.yaml`
- **Directory**: `TOOLS_YAML_PATH=tools/` (loads all .yaml/.yml files)
- **Glob pattern**: `TOOLS_YAML_PATH=tools/**/*.yaml`
- **Multiple sources**: Use CLI `--tools` to override at runtime

**Examples:**
```bash
# Load all tools from a directory
TOOLS_YAML_PATH=tools/
YAML_AUTO_RELOAD=true  # Hot reload on file changes

# Load specific tools file
TOOLS_YAML_PATH=tools/performance-tools.yaml
SELECTED_TOOLSETS=monitoring,diagnostics

# Advanced merging (multiple config sources)
TOOLS_YAML_PATH=tools/
YAML_MERGE_ARRAYS=true  # Combine toolsets from multiple files
YAML_ALLOW_DUPLICATE_TOOLS=false  # Enforce unique tool names
YAML_VALIDATE_MERGED=true  # Validate after merging

# Production: disable hot reload
TOOLS_YAML_PATH=/opt/mcp-tools/production.yaml
YAML_AUTO_RELOAD=false
```

**CLI Override:**
```bash
# Override TOOLS_YAML_PATH at runtime
npx ibmi-mcp-server --tools ./my-custom-tools

# Load specific toolsets only
npx ibmi-mcp-server --toolsets performance,security
```

</details>

<details>
<summary><strong>📊 OpenTelemetry (Observability)</strong></summary>

Configuration for distributed tracing and metrics using OpenTelemetry.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation | `false` | No |
| `OTEL_SERVICE_NAME` | Service name for telemetry data | `MCP_SERVER_NAME` or package name | No |
| `OTEL_SERVICE_VERSION` | Service version for telemetry data | `MCP_SERVER_VERSION` or package version | No |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | OTLP endpoint for trace export | None (logs to file) | No |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | OTLP endpoint for metrics export | None (not exported) | No |
| `OTEL_TRACES_SAMPLER_ARG` | Trace sampling ratio (0.0 to 1.0, where 1.0 = sample all) | `1.0` (100%) | No |
| `OTEL_LOG_LEVEL` | OTel internal diagnostic log level | `INFO` | No |

**Supported OTEL_LOG_LEVEL values:** `NONE`, `ERROR`, `WARN`, `INFO`, `DEBUG`, `VERBOSE`, `ALL`

**Examples:**
```bash
# Development: local file logging only
OTEL_ENABLED=true
OTEL_SERVICE_NAME=ibmi-mcp-dev
OTEL_LOG_LEVEL=DEBUG
# Traces written to logs/traces/ directory

# Production: export to Jaeger
OTEL_ENABLED=true
OTEL_SERVICE_NAME=ibmi-mcp-prod
OTEL_SERVICE_VERSION=1.9.1
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://jaeger:4318/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://jaeger:4318/v1/metrics
OTEL_TRACES_SAMPLER_ARG=0.1  # Sample 10% of traces
OTEL_LOG_LEVEL=WARN

# Production: export to cloud provider
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otlp.example.com/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://otlp.example.com/v1/metrics
OTEL_TRACES_SAMPLER_ARG=1.0  # Sample all traces
```

**Instrumentation Coverage:**
- All MCP tool executions
- HTTP requests and responses
- Database queries (SQL tools)
- Authentication flows
- Custom spans for critical operations

</details>

<details>
<summary><strong>🤖 LLM Provider Integration</strong></summary>

Configuration for Large Language Model providers used by the server.

### OpenRouter

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `OPENROUTER_API_KEY` | API key for OpenRouter.ai service | None | No |
| `OPENROUTER_APP_URL` | Application URL for OpenRouter dashboard | `http://localhost:3000` | No |
| `OPENROUTER_APP_NAME` | Application name for OpenRouter identification | Package name | No |

### LLM Defaults

Default parameters for LLM requests (applied when not specified in request):

| Variable | Description | Default | Range | Required |
|----------|-------------|---------|-------|----------|
| `LLM_DEFAULT_MODEL` | Default model identifier | `google/gemini-2.5-flash` | - | No |
| `LLM_DEFAULT_TEMPERATURE` | Sampling temperature (randomness) | None (provider default) | 0.0 - 2.0 | No |
| `LLM_DEFAULT_TOP_P` | Nucleus sampling threshold | None (provider default) | 0.0 - 1.0 | No |
| `LLM_DEFAULT_MAX_TOKENS` | Maximum tokens in response | None (provider default) | 1+ | No |
| `LLM_DEFAULT_TOP_K` | Top-K sampling (number of candidates) | None (provider default) | 0+ | No |
| `LLM_DEFAULT_MIN_P` | Minimum probability threshold | None (provider default) | 0.0 - 1.0 | No |

**Examples:**
```bash
# Basic OpenRouter setup
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_APP_NAME=ibmi-mcp-server
OPENROUTER_APP_URL=http://localhost:3000

# Custom LLM defaults for deterministic responses
LLM_DEFAULT_MODEL=anthropic/claude-3.5-sonnet
LLM_DEFAULT_TEMPERATURE=0.0  # Deterministic
LLM_DEFAULT_MAX_TOKENS=4000
LLM_DEFAULT_TOP_P=1.0

# Balanced configuration for creative responses
LLM_DEFAULT_MODEL=google/gemini-2.5-flash
LLM_DEFAULT_TEMPERATURE=0.7
LLM_DEFAULT_TOP_P=0.9
LLM_DEFAULT_MAX_TOKENS=2000
```

</details>

<details>
<summary><strong>🔌 OAuth Proxy (Advanced)</strong></summary>

Configuration for OAuth proxy endpoints (advanced use cases).

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `OAUTH_PROXY_AUTHORIZATION_URL` | OAuth authorization endpoint URL | None | No |
| `OAUTH_PROXY_TOKEN_URL` | OAuth token endpoint URL | None | No |
| `OAUTH_PROXY_REVOCATION_URL` | OAuth token revocation endpoint URL | None | No |
| `OAUTH_PROXY_ISSUER_URL` | OAuth issuer URL for proxy | None | No |
| `OAUTH_PROXY_SERVICE_DOCUMENTATION_URL` | Service documentation URL | None | No |
| `OAUTH_PROXY_DEFAULT_CLIENT_REDIRECT_URIS` | Comma-separated default redirect URIs | None | No |

**Example:**
```bash
OAUTH_PROXY_AUTHORIZATION_URL=https://auth.example.com/oauth/authorize
OAUTH_PROXY_TOKEN_URL=https://auth.example.com/oauth/token
OAUTH_PROXY_REVOCATION_URL=https://auth.example.com/oauth/revoke
OAUTH_PROXY_ISSUER_URL=https://auth.example.com
OAUTH_PROXY_SERVICE_DOCUMENTATION_URL=https://docs.example.com/oauth
OAUTH_PROXY_DEFAULT_CLIENT_REDIRECT_URIS=http://localhost:3000/callback,https://app.example.com/callback
```

> **Note:** OAuth proxy features are for advanced integration scenarios. Most users should use standard OAuth authentication via `MCP_AUTH_MODE=oauth`.

</details>

---

### Configuration Best Practices

**Development:**
```bash
# Recommended development .env
MCP_TRANSPORT_TYPE=http
MCP_HTTP_PORT=3010
MCP_SESSION_MODE=auto
MCP_LOG_LEVEL=debug
MCP_AUTH_MODE=none  # Or ibmi with allow HTTP
NODE_ENV=development

DB2i_HOST=ibmi-dev.local
DB2i_USER=DEVUSER
DB2i_PASS=devpass
DB2i_IGNORE_UNAUTHORIZED=true

TOOLS_YAML_PATH=tools/
YAML_AUTO_RELOAD=true
OTEL_ENABLED=true
```

**Production:**
```bash
# Recommended production .env
MCP_TRANSPORT_TYPE=http
MCP_HTTP_PORT=3010
MCP_SESSION_MODE=auto
MCP_LOG_LEVEL=warn
MCP_AUTH_MODE=ibmi  # Or jwt/oauth
NODE_ENV=production

DB2i_HOST=ibmi-prod.example.com
DB2i_USER=PRODUSER
DB2i_PASS=${SECURE_PASSWORD_FROM_VAULT}
DB2i_IGNORE_UNAUTHORIZED=false  # Require valid SSL

TOOLS_YAML_PATH=/opt/mcp-tools/production.yaml
YAML_AUTO_RELOAD=false
YAML_VALIDATE_MERGED=true

IBMI_HTTP_AUTH_ENABLED=true
IBMI_AUTH_ALLOW_HTTP=false  # HTTPS only
IBMI_AUTH_PRIVATE_KEY_PATH=/opt/secrets/private.pem
IBMI_AUTH_PUBLIC_KEY_PATH=/opt/secrets/public.pem

OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otlp.example.com/v1/traces
```

**Security Checklist:**
- ✅ Never commit `.env` files to version control
- ✅ Use secrets management (Vault, AWS Secrets Manager, etc.) in production
- ✅ Rotate credentials and keys regularly
- ✅ Use HTTPS/TLS in production (`IBMI_AUTH_ALLOW_HTTP=false`)
- ✅ Enable authentication (`MCP_AUTH_MODE != none`)
- ✅ Use strong passwords (12+ characters, mixed case, numbers, symbols)
- ✅ Restrict `MCP_ALLOWED_ORIGINS` to known domains
- ✅ Set appropriate `IBMI_AUTH_MAX_CONCURRENT_SESSIONS` limits

## 🔐 IBM i HTTP Authentication (Beta)

The server supports IBM i HTTP authentication that allows clients to obtain access tokens for authenticated SQL tool execution. This enables per-user connection pooling and secure access to IBM i resources.

### Authentication Flow

1. **Client Authentication**: Clients authenticate with IBM i credentials via HTTP Basic Auth
2. **Token Generation**: Server creates a secure Bearer token and establishes a dedicated connection pool
3. **Tool Execution**: Subsequent tool calls use the Bearer token for authenticated execution
4. **Pool Management**: Each token maintains its own connection pool for isolation and security

### Configuration

To enable IBM i HTTP authentication, we need to set up Encryption keys and configure the server environment. To protect IBM i credentials during transmission, the authentication flow uses RSA and AES encryption. You need to generate an RSA keypair for the server:

```bash
mkdir -p secrets
openssl genpkey -algorithm RSA -out secrets/private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -pubout -in secrets/private.pem -out secrets/public.pem
```

Create or update your `.env` file with the following settings:

```ini
# Enable IBM i authentication system
IBMI_HTTP_AUTH_ENABLED=true
MCP_AUTH_MODE=ibmi

# IBM i authentication settings
IBMI_AUTH_KEY_ID=development
IBMI_AUTH_PRIVATE_KEY_PATH=secrets/private.pem
IBMI_AUTH_PUBLIC_KEY_PATH=secrets/public.pem

# Security settings
IBMI_AUTH_ALLOW_HTTP=true          # Development only - use HTTPS in production
IBMI_AUTH_TOKEN_EXPIRY_SECONDS=3600 # Token lifetime (1 hour)

# Resource management
IBMI_AUTH_MAX_CONCURRENT_SESSIONS=100
IBMI_AUTH_CLEANUP_INTERVAL_SECONDS=300

# IBM i connection details
DB2i_HOST=your-ibmi-host
DB2i_USER=your-username
DB2i_PASS=your-password
```


### Getting Access Tokens

#### Option 1: Using the Token Script (Recommended)

Use the included `get-access-token.js` script to obtain authentication tokens:

```bash
# Using credentials from .env file
node get-access-token.js --verbose

# Using CLI arguments (overrides .env)
node get-access-token.js --user myuser --password mypass --host my-ibmi-host

# Quiet mode for shell evaluation
eval $(node get-access-token.js --quiet)
echo $IBMI_MCP_ACCESS_TOKEN
```

The script automatically:

- Loads IBM i credentials from `.env` with CLI fallback
- Fetches the server's public key
- Encrypts credentials client-side
- Requests an access token
- Sets `IBMI_MCP_ACCESS_TOKEN` environment variable
- Provides copy-paste export commands

#### Sequence Overview

```mermaid
sequenceDiagram
    participant CLI as Client CLI
    participant Auth as MCP Server (/api/v1/auth)
    participant IBM as IBM i

    CLI->>Auth: GET /api/v1/auth/public-key
    Auth-->>CLI: { keyId, publicKey }

    CLI->>CLI: Generate AES-256-GCM session key + IV
    CLI->>CLI: Encrypt credentials + request body with session key
    CLI->>CLI: Encrypt session key with server public key (RSA-OAEP)

    CLI->>Auth: POST /api/v1/auth { keyId, encryptedSessionKey, iv, authTag, ciphertext }
    Auth->>Auth: Look up keyId, decrypt session key with private key
    Auth->>Auth: Decrypt ciphertext, validate GCM tag, validate payload

    Auth->>IBM: Authenticate against IBM i with decrypted credentials
    IBM-->>Auth: Success/Failure

    Auth->>Auth: Generate access token, provision pool session
    Auth-->>CLI: 201 JSON { access_token, expires_in, ... }
```

### Client Integration

Once you have a token, use it in your MCP client to authenticate requests:

```python
import asyncio
import os
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async def main():
    # Get the access token from environment
    token = os.environ.get('IBMI_MCP_ACCESS_TOKEN')
    if not token:
        raise ValueError("IBMI_MCP_ACCESS_TOKEN environment variable not set")

    # Set up authentication headers
    headers = {"Authorization": f"Bearer {token}"}

    # Connect to the IBM i MCP server with authentication
    async with streamablehttp_client(
        "http://localhost:3010/mcp",
        headers=headers
    ) as (read_stream, write_stream, _):
        # Create a session using the authenticated streams
        async with ClientSession(read_stream, write_stream) as session:
            # Initialize the connection
            await session.initialize()

            # List available tools (now authenticated with your IBM i credentials)
            tools = await session.list_tools()
            print(f"Available tools: {[tool.name for tool in tools.tools]}")

            # Execute a tool with authenticated IBM i access
            result = await session.call_tool("system_status", {})
            print(f"System status result: {result}")

if __name__ == "__main__":
    asyncio.run(main())
```

### Security Considerations

**Development Environment:**

- `IBMI_AUTH_ALLOW_HTTP=true` allows HTTP for testing
- Use localhost/trusted networks only
- Shorter token lifetimes for testing

**Production Environment:**

- `IBMI_AUTH_ALLOW_HTTP=false` enforces HTTPS
- Use proper TLS certificates
- Longer token lifetimes for stability
- Network security and access controls
- Monitor `IBMI_AUTH_MAX_CONCURRENT_SESSIONS` for resource usage

### Authentication Endpoints

When enabled (`IBMI_HTTP_AUTH_ENABLED=true`), the server provides these endpoints:

| Endpoint       | Method | Description                                                  |
| -------------- | ------ | ------------------------------------------------------------ |
| `/api/v1/auth` | POST   | Authenticate with IBM i credentials and receive Bearer token |

## 🧩 SQL Tool Configuration

The Primary way to confgure tools used by this MCP server is through `tools.yaml` files (see `tools/` for examples). There are 3 main sections to each yaml file: `sources`, `tools`, and `toolsets`. Below is a breakdown of each section

### Sources

The sources section of your `tools.yaml` defines the data sources the MCP server has access to

```yaml
sources:
  ibmi-system:
    host: ${DB2i_HOST}
    user: ${DB2i_USER}
    password: ${DB2i_PASS}
    port: 8076
    ignore-unauthorized: true
```

> [!NOTE]
> The environment variables `DB2i_HOST`, `DB2i_USER`, `DB2i_PASS`, and `DB2i_PORT` can be set in the server `.env` file. see [Configuration](#⚙️-configuration)

### Tools

The tools section of your tools.yaml defines the actions your agent can take: what kind of tool it is, which source(s) it affects, what parameters it uses, etc.

```yaml
tools:
  system_status:
    source: ibmi-system
    description: "Overall system performance statistics with CPU, memory, and I/O metrics"
    parameters: []
    statement: |
      SELECT * FROM TABLE(QSYS2.SYSTEM_STATUS(RESET_STATISTICS=>'YES',DETAILED_INFO=>'ALL')) X
```

### Toolsets

The toolsets section of your `tools.yaml` allows you to define groups of tools that you want to be able to load together. This can be useful for defining different sets for different agents or different applications.

```yaml
toolsets:
  performance:
    tools:
      - system_status
      - system_activity
      - remote_connections
      - memory_pools
      - temp_storage_buckets
      - unnamed_temp_storage
      - http_server
      - system_values
      - collection_services
      - collection_categories
      - active_job_info
```

More documentation on SQL tools coming soon!

## 🚀 Running the Server (Development)

The server supports multiple transport modes and session configurations for different development scenarios. Use the appropriate startup command based on your needs.

### Transport Modes

#### HTTP Transport (Recommended for Development)

```bash
# Basic HTTP server
npm run start:http

# HTTP with custom tools path
npm run start:http -- --tools ./my-configs

# HTTP with specific toolsets
npm run start:http -- --toolsets performance,monitoring
```

#### Stdio Transport (for CLI tools and MCP Inspector)

```bash
# Basic stdio transport
npm run start:stdio

# Stdio with custom tools path
npm run start:stdio -- --tools ./my-custom-tools
```

> Make sure that to use the absolute path for tools

### Session Modes (HTTP Only)

The `MCP_SESSION_MODE` environment variable controls how the HTTP server handles client sessions:

- **`auto` (default)**: Automatically detects client capabilities and uses the best session mode
- **`stateful`**: Maintains persistent sessions with connection state
- **`stateless`**: Each request is independent, no session state maintained

```bash
# Set session mode via environment variable
MCP_SESSION_MODE=stateful npm run start:http

# Or set in .env file
echo "MCP_SESSION_MODE=stateful" >> .env
npm run start:http
```

### CLI Options

Both transport modes support these command-line options:

> **Note**: CLI arguments override corresponding settings in `.env` file when provided.

| Option               | Short | Description                                                                   | Example                           |
| -------------------- | ----- | ----------------------------------------------------------------------------- | --------------------------------- |
| `--tools <path>`     |       | Override YAML tools configuration path (overrides `TOOLS_YAML_PATH`)          | `--tools ./custom-configs`        |
| `--toolsets <list>`  | `-ts` | Load only specific toolsets (comma-separated) (overrides `SELECTED_TOOLSETS`) | `--toolsets performance,security` |
| `--transport <type>` | `-t`  | Force transport type (`http` or `stdio`) (overrides `MCP_TRANSPORT_TYPE`)     | `--transport http`                |
| `--help`             | `-h`  | Show help information                                                         | `--help`                          |
| `--list-toolsets`    |       | List available toolsets from YAML configuration                               | `--list-toolsets`                 |

### Common Development Scenarios

**1. Standard Development Server**

```bash
npm run start:http
# Server: http://localhost:3010/mcp
# Tools: tools/ (from .env)
# Session: auto-detected
```

**2. Custom Tools Path**

```bash
npm run start:http -- --tools ./my-tools
# Server: http://localhost:3010/mcp (port from .env or default)
# Tools: ./my-tools
```

**3. Specific Toolsets Only**

```bash
npm run start:http -- --toolsets performance,monitoring
# Only loads tools from 'performance' and 'monitoring' toolsets
```

### Development Tips

- **Hot Reloading**: Enable `YAML_AUTO_RELOAD=true` in `.env` for automatic tool configuration updates
- **Verbose Logging**: Set `MCP_LOG_LEVEL=debug` for detailed operation logs
- **CORS**: Configure `MCP_ALLOWED_ORIGINS` for web-based clients
- **Authentication**: Use `MCP_AUTH_MODE=ibmi` with IBM i HTTP auth for token-based access

### Troubleshooting

**Port Already in Use**

```bash
# Configure port in .env file
echo "MCP_HTTP_PORT=3011" >> .env
npm run start:http
```

**Tools Not Loading**

```bash
# Check tools path
npm run start:http -- --tools ./tools

# List available toolsets first
npm run start:http -- --list-toolsets --tools ./tools

# Get help
npm run start:http -- --help
```

## 🕵️‍♂️ MCP Inspector

The MCP Inspector is a tool for exploring and debugging the MCP server's capabilities. It provides a user-friendly interface for interacting with the server, viewing available tools, and testing queries.

Here are the steps to run the MCP Inspector:

1. Make sure to build the server
   ```bash
   cd ibmi-mcp-server/
   npm run build
   ```
2. Create an `mcp.json` file:

   ```bash
   cp template_mcp.json mcp.json
   ```

   Fill out the connection details in `mcp.json` with your IBM i system information. You should use the same credentials as in your `.env` file:

   ```json
   {
     "mcpServers": {
       "default-server": {
         "command": "node",
         "args": ["dist/index.js"],
         "env": {
           "TOOLS_YAML_PATH": "tools",
           "NODE_OPTIONS": "--no-deprecation",
           "DB2i_HOST": "<DB2i_HOST>",
           "DB2i_USER": "<DB2i_USER>",
           "DB2i_PASS": "<DB2i_PASS>",
           "DB2i_PORT": "<DB2i_PORT>",
           "MCP_TRANSPORT_TYPE": "stdio"
         }
       }
     }
   }
   ```

3. Start the MCP Inspector
   ```bash
   npm run mcp-inspector
   ```
4. Click on the URL displayed in the terminal to open the MCP Inspector in your web browser.

   ```bash
    Starting MCP inspector...
    ⚙️ Proxy server listening on 127.0.0.1:6277
    🔑 Session token: EXAMPLE_TOKEN
    Use this token to authenticate requests or set DANGEROUSLY_OMIT_AUTH=true to disable auth

    🔗 Open inspector with token pre-filled:
      http://localhost:6274/?MCP_PROXY_AUTH_TOKEN=EXAMPLE_TOKEN

    🔍 MCP Inspector is up and running at http://127.0.0.1:6274 🚀
   ```

![alt text](docs/images/inspector.png)

5. Use the MCP Inspector to explore and test your MCP server's capabilities
   - View available tools and their parameters
   - Test queries against the server
   - Debug issues with tool execution

## Docker & Podman Deployment

The project includes a comprehensive `docker-compose.yml` that sets up the complete MCP gateway with the IBM i MCP Server.

ContextForge MCP Gateway is a feature-rich gateway, proxy and MCP Registry that federates MCP and REST services - unifying discovery, auth, rate-limiting, observability, virtual servers, multi-transport protocols, and an optional Admin UI into one clean endpoint for your AI clients.

Read more about it [here](https://github.com/IBM/mcp-context-forge).

### Prerequisites

Choose one of the following container platforms:

#### Docker

- **Docker Desktop** (macOS/Windows): [Download here](https://www.docker.com/products/docker-desktop/)
- **Docker Engine** (Linux): [Installation guide](https://docs.docker.com/engine/install/)

#### Podman (Alternative to Docker)

- **Podman Desktop** (macOS/Windows): [Download here](https://podman-desktop.io/)
- **Podman CLI** (Linux): [Installation guide](https://podman.io/docs/installation)
- **podman-compose**: `pip install podman-compose`

#### Build MCP Gateway Image

The `docker-compose.yml` uses a local build of the MCP Gateway image. To build it, clone the MCP Gateway repository and build the image:

```bash
git clone https://github.com/IBM/mcp-context-forge.git
cd mcp-context-forge

# Build image using Docker
make docker-prod

# Or build image using Podman
make podman-prod
```
This will create a local image named `localhost/mcpgateway/mcpgateway` that the `docker-compose.yml` can use. More details on building the MCP Gateway image can be found in the [MCP Gateway Docs](https://ibm.github.io/mcp-context-forge/deployment/).

#### Configure MCP environment

Create a `.env` file in the `ibmi-mcp-server` directory with your IBM i connection details:

```bash
cd ibmi-mcp-server/
cp .env.example .env
# Edit .env with your IBM i connection details
code .env
```

make sure to set the follow variables in your `.env` file:

```ini
# IBM i connection details
DB2i_HOST="your_host"
DB2i_USER="your_user"
DB2i_PASS="your_pass"

# MCP Auth mode
MCP_AUTH_MODE=ibmi

# IBM i HTTP authentication settings
IBMI_AUTH_KEY_ID=development
IBMI_AUTH_PRIVATE_KEY_PATH=secrets/private.pem
IBMI_AUTH_PUBLIC_KEY_PATH=secrets/public.pem

# Enable IBM i HTTP authentication endpoints (requires MCP_AUTH_MODE=ibmi)
IBMI_HTTP_AUTH_ENABLED=true

# Allow HTTP requests for authentication (development only, use HTTPS in production)
IBMI_AUTH_ALLOW_HTTP=true
```

> Note: You need to generate an RSA keypair for the server if you haven't already done so. See the [IBM i HTTP Authentication](#ibm-i-http-authentication-beta) section for instructions.

Once you have your `.env` file configured, you can start the complete stack using Docker or Podman.


### Quick Start with Docker

1. **Start the complete stack:**

   ```bash
   # Start all services in background
   docker-compose up -d

   # Or start specific services
   docker-compose up -d gateway ibmi-mcp-server postgres redis
   ```

2. **Verify services are running:**
   ```bash
   docker-compose ps
   ```

### Quick Start with Podman

1. **Start the complete stack:**

   ```bash
   # Start all services in background
   podman compose up -d

   # Or start specific services
   podman compose up -d gateway ibmi-mcp-server postgres redis
   ```

2. **Verify services are running:**
   ```bash
   podman compose ps
   ```

### Container Architecture

The docker-compose setup includes these services:

| Service             | Port | Description                    | Access URL             |
| ------------------- | ---- | ------------------------------ | ---------------------- |
| **gateway**         | 4444 | MCP Context Forge main API     | http://localhost:4444  |
| **ibmi-mcp-server** | 3010 | IBM i SQL tools MCP server     | http://localhost:3010  |
| **postgres**        | -    | PostgreSQL database (internal) | -                      |
| **redis**           | 6379 | Cache service                  | redis://localhost:6379 |
| **pgadmin**         | 5050 | Database admin UI              | http://localhost:5050  |
| **redis_insight**   | 5540 | Cache admin UI                 | http://localhost:5540  |

### 🔧 Service Management

#### Start Services

```bash
# Docker
docker-compose up -d                    # Start all services
docker-compose up -d gateway            # Start specific service
docker-compose up --no-deps gateway     # Start without dependencies

# Podman
podman compose up -d                    # Start all services
podman compose up -d gateway            # Start specific service
podman compose up --no-deps gateway     # Start without dependencies
```

#### Stop Services

```bash
# Docker
docker-compose down                     # Stop all services
docker-compose stop gateway             # Stop specific service

# Podman
podman compose down                     # Stop all services
podman compose stop gateway             # Stop specific service
```

#### View Logs

```bash
# Docker
docker-compose logs -f gateway          # Follow gateway logs
docker-compose logs --tail=100 ibmi-mcp-server

# Podman
podman compose logs -f gateway          # Follow gateway logs
podman compose logs --tail=100 ibmi-mcp-server
```

#### Rebuild Services

```bash
# Docker
docker-compose build ibmi-mcp-server    # Rebuild specific service
docker-compose up --build -d            # Rebuild and restart all

# Podman
podman compose build ibmi-mcp-server    # Rebuild specific service
podman compose up --build -d            # Rebuild and restart all
```

### MCP Gateway UI:

![alt text](docs/images/image.png)

After the Containers are up and running, you can access the MCP Context Forge UI at http://localhost:4444

Enter the demo credentials:

- User: `admin`
- Password: `changeme`

To Configure the IBM i MCP server is the admin ui, navigate to the "Gateways/MCP Servers" tab. and enter the mcp server endpoint:

- IBM i mcp server endpoint: `http://ibmi-mcp-server:3010`

![alt text](docs/images/image-1.png)

Once the MCP server is connect, you can then manage the tools provided by the server:

![alt text](docs/images/image-2.png)

### Virtual Server Catalog Demo (Comming soon!!)

## Openshift Deployment

OpenShift (both OKD and Red Hat OpenShift Container Platform) adds opinionated security (SCC), integrated routing, and optional build pipelines on top of Kubernetes. Deploying the applications therefore means (1) building or pulling a compatible image, (2) obeying the default restricted-v2 SCC, and (3) exposing the service through a Route instead of an Ingress. The deployment uses `Kustomize` tool to manage the application manifests to simply the process of deploying IBM i MCP Server and MCP Context Forge applications. Following the detailed instructions in this [link](deployment/openshift/apps/openshift/README.md) to deploy the application in OpenShift.


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
- **`src/config/`**: Handles loading and validation of environment variables.
- **`src/services/`**: Reusable modules for integrating with external services (DuckDB, OpenRouter).
- **`src/types-global/`**: Defines shared TypeScript interfaces and type definitions.
- **`src/utils/`**: Core utilities (logging, error handling, security, etc.).
- **`src/index.ts`**: The main entry point that initializes and starts the server.

**Explore the full structure yourself:**

See the current file tree in [docs/tree.md](docs/tree.md) or generate it dynamically:

```bash
npm run tree
```

### Extending the System

The template enforces a strict, modular pattern for adding new tools and resources, as mandated by the [Architectural Standard](./.clinerules/clinerules.md). The `echoTool` (`src/mcp-server/tools/echoTool/`) serves as the canonical example.

### The "Logic Throws, Handler Catches" Pattern

This is the cornerstone of the architecture:

1.  **`logic.ts`**: This file contains the pure business logic.
    - It defines the Zod schemas for input and output, which serve as the single source of truth for the tool's data contract.
    - The core logic function is pure: it takes validated parameters and a request context, and either returns a result or **throws** a structured `McpError`.
    - It **never** contains `try...catch` blocks for formatting a final response.

2.  **`registration.ts`**: This file is the "handler" that connects the logic to the MCP server.
    - It imports the schemas and logic function from `logic.ts`.
    - It calls `server.registerTool()`, providing the tool's metadata and the runtime handler.
    - The runtime handler **always** wraps the call to the logic function in a `try...catch` block. This is the **only** place where errors are caught, processed by the `ErrorHandler`, and formatted into a standardized error response.

This pattern ensures that core logic remains decoupled, pure, and easily testable, while the registration layer handles all transport-level concerns, side effects, and response formatting.

## 📜 License

This project is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.
