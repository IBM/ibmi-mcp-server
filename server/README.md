# IBM i MCP Server

<details>

<summary><strong>Table of Contents</strong></summary>

- [IBM i MCP Server](#ibm-i-mcp-server)
  - [⚡ Quickstart](#-quickstart)
    - [1. Create Configuration File](#1-create-configuration-file)
    - [2. Create a Simple SQL Tool](#2-create-a-simple-sql-tool)
    - [3. Set Configuration Path](#3-set-configuration-path)
    - [4. Run the Server](#4-run-the-server)
    - [5. Verify Server is Running](#5-verify-server-is-running)
    - [6. Test with Python Client (Optional)](#6-test-with-python-client-optional)
  - [🎯 What's Next?](#-whats-next)
  - [CLI Reference](#cli-reference)
    - [Basic Usage](#basic-usage)
    - [Available Options](#available-options)
  - [🔌 Installing in MCP Clients](#-installing-in-mcp-clients)
    - [Prerequisites: Local Installation](#prerequisites-local-installation)
    - [Remote Server Setup](#remote-server-setup)
    - [Client Configurations](#client-configurations)
  - [🧩 SQL Tool Configuration](#-sql-tool-configuration)
    - [Sources](#sources)
    - [Tools](#tools)
    - [Toolsets](#toolsets)
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
  - [🛠️ Running the Server (Development)](#️-running-the-server-development)
    - [Building from Source](#building-from-source)
    - [Transport Modes](#transport-modes)
      - [HTTP Transport (Recommended for Development)](#http-transport-recommended-for-development)
      - [Stdio Transport (for CLI tools and MCP Inspector)](#stdio-transport-for-cli-tools-and-mcp-inspector)
    - [Session Modes (HTTP Only)](#session-modes-http-only)
    - [CLI Options](#cli-options)
    - [Common Development Scenarios](#common-development-scenarios)
    - [Development Tips](#development-tips)
    - [Troubleshooting](#troubleshooting)
  - [🕵️‍♂️ MCP Inspector](#️️-mcp-inspector)
  - [Deployment](#deployment)
  - [🏗️ Built With MCP TypeScript Template](#️-built-with-mcp-typescript-template)
    - [Template Features Used](#template-features-used)
    - [Why This Template?](#why-this-template)
    - [Customizations for IBM i](#customizations-for-ibm-i)
    - [Get Started with the Template](#get-started-with-the-template)

</details>

---

## ⚡ Quickstart

Get started with the IBM i MCP Server using the official npm package.

### 1. Create Configuration File

Create a `.env` file with your IBM i connection details:

```bash
cat > .env << 'EOF'
# IBM i DB2 for i Connection Settings
DB2i_HOST=your-ibmi-host.com
DB2i_USER=your-username
DB2i_PASS=your-password
DB2i_PORT=8076
DB2i_IGNORE_UNAUTHORIZED=true

# MCP Server Settings
MCP_TRANSPORT_TYPE=http
MCP_HTTP_PORT=3010
MCP_LOG_LEVEL=info

# Tools Configuration
TOOLS_YAML_PATH=./tools
EOF
```

> **📖 Configuration Guide:** See the complete [Configuration](#⚙️-configuration) section for all available settings.

### 2. Create a Simple SQL Tool

Create a `tools` directory and a basic tool configuration file:

```bash
mkdir -p tools
```

<details>
<summary><strong>📄 Click to copy: tools/quickstart.yaml</strong></summary>

```yaml
sources:
  ibmi-system:
    host: ${DB2i_HOST}
    user: ${DB2i_USER}
    password: ${DB2i_PASS}
    port: 8076
    ignore-unauthorized: true

tools:
  system_status:
    source: ibmi-system
    description: "Overall system performance statistics with CPU, memory, and I/O metrics"
    parameters: []
    statement: |
      SELECT * FROM TABLE(QSYS2.SYSTEM_STATUS(RESET_STATISTICS=>'YES',DETAILED_INFO=>'ALL')) X

  system_activity:
    source: ibmi-system
    description: "Current system activity information including active jobs and resource utilization"
    parameters: []
    statement: |
      SELECT * FROM TABLE(QSYS2.SYSTEM_ACTIVITY_INFO())

  active_job_info:
    source: ibmi-system
    description: "Find the top 10 consumers of CPU in the QUSRWRK and QSYSWRK subsystems"
    parameters:
      - name: limit
        type: integer
        default: 10
        description: "Number of top CPU consumers to return"
    statement: |
      SELECT CPU_TIME, A.* FROM
      TABLE(QSYS2.ACTIVE_JOB_INFO(SUBSYSTEM_LIST_FILTER => 'QUSRWRK,QSYSWRK')) A
      ORDER BY CPU_TIME DESC
      FETCH FIRST :limit ROWS ONLY

toolsets:
  performance:
    tools:
      - system_status
      - system_activity
      - active_job_info
```

</details>

Create the file:

```bash
cat > tools/quickstart.yaml << 'EOF'
sources:
  ibmi-system:
    host: ${DB2i_HOST}
    user: ${DB2i_USER}
    password: ${DB2i_PASS}
    port: 8076
    ignore-unauthorized: true

tools:
  system_status:
    source: ibmi-system
    description: "Overall system performance statistics with CPU, memory, and I/O metrics"
    parameters: []
    statement: |
      SELECT * FROM TABLE(QSYS2.SYSTEM_STATUS(RESET_STATISTICS=>'YES',DETAILED_INFO=>'ALL')) X

  system_activity:
    source: ibmi-system
    description: "Current system activity information including active jobs and resource utilization"
    parameters: []
    statement: |
      SELECT * FROM TABLE(QSYS2.SYSTEM_ACTIVITY_INFO())

  active_job_info:
    source: ibmi-system
    description: "Find the top 10 consumers of CPU in the QUSRWRK and QSYSWRK subsystems"
    parameters:
      - name: limit
        type: integer
        default: 10
        description: "Number of top CPU consumers to return"
    statement: |
      SELECT CPU_TIME, A.* FROM
      TABLE(QSYS2.ACTIVE_JOB_INFO(SUBSYSTEM_LIST_FILTER => 'QUSRWRK,QSYSWRK')) A
      ORDER BY CPU_TIME DESC
      FETCH FIRST :limit ROWS ONLY

toolsets:
  performance:
    tools:
      - system_status
      - system_activity
      - active_job_info
EOF
```

This creates three tools:
- **`system_status`** - System performance metrics
- **`system_activity`** - Current activity information
- **`active_job_info`** - Top CPU consumers (with customizable limit parameter)

> [!NOTE] 
> **📖 More Tools:** The repository includes many ready-to-use tools in the [`tools/`](../tools/) directory covering performance monitoring, security, job management, and more. See [SQL Tool Configuration](#-sql-tool-configuration) to create your own custom tools.

### 3. Set Configuration Path

Point the server to your configuration file using the `MCP_SERVER_CONFIG` environment variable:

```bash
# Set configuration file path
export MCP_SERVER_CONFIG=.env
```

> **Note:** CLI arguments override settings in the configuration file.

### 4. Run the Server

Start the server in HTTP mode with your new tools:

```bash
# Start the server with HTTP transport
npx @ibm/ibmi-mcp-server@latest --transport http --tools ./tools/quckstart.yaml
```

The server will:
- Load configuration from `.env` (via `MCP_SERVER_CONFIG`)
- Connect to your IBM i system via Mapepire
- Start on `http://localhost:3010/mcp`
- Load the SQL tools from `tools/quickstart.yaml`



### 5. Verify Server is Running

Test the server endpoint:

```bash
# Check health
curl http://localhost:3010/healthz

# List available tools (requires running server)
curl -X POST http://localhost:3010/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'
```

### 6. Test with Python Client (Optional)

Install and run the example Python client:

```bash
# Navigate to client directory
cd client/

# Install dependencies with uv
uv sync

# List available tools
uv run mcp_client.py

# Run agent with LLM (requires API key)
export OPENAI_API_KEY=your-api-key
uv run agent.py -p "What is my system status?"
```

> **📖 Client Documentation:** See [client/README.md](../client/README.md) for detailed setup instructions.

> [!TIP]
> **Explore More SQL Tools:** The `tools/` directory contains many ready-to-use SQL tool configurations for common IBM i tasks. Browse the collection and customize them for your needs. See the [Tools Guide](../tools/README.md) for more details.

---

## 🎯 What's Next?

Choose your path based on what you want to accomplish:

| Path | Guide | Description |
|------|-------|-------------|
| **MCP Client Integration** | [Installing in MCP Clients](#-installing-in-mcp-clients) | Connect to Claude Desktop, VSCode, Cursor, and other MCP clients |
| **Custom SQL Tools** | [SQL Tool Configuration](#-sql-tool-configuration) | Create YAML-based SQL tools for your IBM i use cases |
| **Server Configuration** | [Configuration Guide](#️-configuration) | Explore authentication, transport modes, and environment variables |
| **Production Deployment** | [Deployment Options](../deployment/README.md) | Deploy with Docker, Podman, or OpenShift |
| **AI Agent Development** | [IBM i Agents](#-ibm-i-agents) | Build custom AI agents that interact with IBM i systems |
| **Development & Contributing** | [Running the Server (Development)](#️-running-the-server-development) | Build from source, run tests, and contribute |

---

## CLI Reference

The IBM i MCP Server provides a command-line interface with flexible options for running and configuring the server.

### Basic Usage

```bash
npx @ibm/ibmi-mcp-server@latest -y [options]
```

> **Note:** The `-y` flag automatically accepts the npm package installation prompt.

### Available Options

| Option | Description |
|--------|-------------|
| `--tools <path>` | Path to YAML tools (file, directory, or glob pattern) |
| `--toolsets <list>` | Comma-separated list of toolsets to load |
| `--list-toolsets` | List all available toolsets and exit |
| `--transport <type>` | Transport type: `stdio` (default) or `http` |
| `--help` | Show help message |

<details>
<summary><strong>Common Examples</strong></summary>

**Run server with stdio transport (for MCP clients):**
```bash
npx @ibm/ibmi-mcp-server@latest -y --transport stdio --tools ./tools
```

**Run HTTP server for testing:**
```bash
npx @ibm/ibmi-mcp-server@latest -y --transport http --tools ./tools
```

**Load specific toolsets only:**
```bash
npx @ibm/ibmi-mcp-server@latest -y --toolsets performance,security
```

**List available toolsets:**
```bash
npx @ibm/ibmi-mcp-server@latest -y --list-toolsets --tools ./tools
```

**Use custom tools directory:**
```bash
npx @ibm/ibmi-mcp-server@latest -y --tools /absolute/path/to/custom-tools
```

</details>

---

## 🔌 Installing in MCP Clients

This server can be integrated into any MCP-compatible client using either **local** (stdio) or **remote** (HTTP) connections.

### Prerequisites: Local Installation

The server is available as an npm package and can be used directly with `npx`:

```bash
# Test the server is available
npx @ibm/ibmi-mcp-server@latest -y --help
```

> **Note:** The `-y` flag automatically accepts the npm package installation prompt.
> `TOOLS_YAML_PATH` must be an **absolute path** to your tools configuration directory (e.g., `/full/path/to/tools`).

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

In production environments, it is strongly recommended to deploy the MCP server behind a reverse proxy server such as Nginx, HAProxy, or Caddy. The reverse proxy server can provide TLS/SSL termination for the MCP server to handle HTTPS connections and SSL/TLS certificate management. Below is an example of an Nginx configuration. You may need to adjust it according to your specific networking configuration and security requirements.

```
pid /run/nginx.pid;
events {}
http {
    server {
        listen 443 ssl;
        ssl_certificate <path_to_certificate>;
        ssl_certificate_key <path_to_privatekey>;
        ssl_protocols TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_session_cache shared:SSL:50m;
        ssl_prefer_server_ciphers on;
        # This is needed for getting access token when IBM i HTTP authentication enabled with HTTPS only
        proxy_set_header X-Forwarded-Proto https;
        location / {
            proxy_pass http://mcp_server;
        }
    }
    upstream mcp_server {
        server 127.0.0.1:3010;
    }
}
```

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
  -- npx @ibm/ibmi-mcp-server@latest -y --transport stdio --tools /absolute/path/to/tools
```

**Using `.mcp.json`:**
```json
{
  "mcpServers": {
    "ibmi-mcp": {
      "command": "npx",
      "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
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
      "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "${IBMI_TOOLS_PATH}"],
      "env": {
        "DB2i_HOST": "${DB2i_HOST}",
        "DB2i_USER": "${DB2i_USER}",
        "DB2i_PASS": "${DB2i_PASS}",
        "DB2i_PORT": "${DB2i_PORT:-8076}"
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
      "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076"
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
  "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
  "env": {
    "DB2i_HOST": "your-ibmi-host.com",
    "DB2i_USER": "your-username",
    "DB2i_PASS": "your-password",
    "DB2i_PORT": "8076"
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
      "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076"
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
      "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "${input:db2iHost}",
        "DB2i_USER": "${input:db2iUser}",
        "DB2i_PASS": "${input:db2iPass}",
        "DB2i_PORT": "8076"
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
      "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076"
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
      "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076"
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
      "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076"
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
      "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076",
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
      "command": ["npx", "@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
      "environment": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076"
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
      "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076"
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
      "args": ["@ibm/ibmi-mcp-server@latest", "-y", "--transport", "stdio", "--tools", "/absolute/path/to/tools"],
      "env": {
        "DB2i_HOST": "your-ibmi-host.com",
        "DB2i_USER": "your-username",
        "DB2i_PASS": "your-password",
        "DB2i_PORT": "8076"
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

## 🧩 SQL Tool Configuration

The primary way to configure tools used by this MCP server is through `tools.yaml` files (see `tools/` for examples). There are 3 main sections to each yaml file: `sources`, `tools`, and `toolsets`. Below is a breakdown of each section.

### Sources

The sources section of your `tools.yaml` defines the data sources the MCP server has access to:

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
> The environment variables `DB2i_HOST`, `DB2i_USER`, `DB2i_PASS`, and `DB2i_PORT` can be set in the server `.env` file. See [Configuration](#️-configuration) for all available settings.

### Tools

The tools section of your `tools.yaml` defines the actions your agent can take: what kind of tool it is, which source(s) it affects, what parameters it uses, etc.

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

> [!TIP]
> **Advanced Tool Configuration:** For detailed documentation on creating custom SQL tools, parameter validation, advanced queries, and more, see [tools/README.md](../tools/README.md).

---

## 🤖 IBM i Agents

IBM i Agents are specialized components designed to interact with the IBM i system, providing capabilities such as monitoring, management, and automation.

### Key Features
- **Integration with IBM i:** Seamless integration with IBM i system APIs and tools.
- **Modular Architecture:** Easily extendable and customizable to fit specific use cases.
- **Real-time Monitoring:** Continuous monitoring of system performance and health.

### Getting Started

Navigate to the `agents` directory and follow the setup instructions in the [README](../agents/README.md). This includes details on configuration, running agents, and examples. Most agent examples require the MCP server to be running in HTTP mode. Read the docs for each agent example for details.

  



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

Settings for loading and managing SQL tools defined in YAML configuration files. See [Tools Documentation](../tools/README.md) for YAML tool development.

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



## 🛠️ Running the Server (Development)

For development and contributions, you can build and run the server from source.

### Building from Source

**1. Clone and Install:**

```bash
git clone https://github.com/IBM/ibmi-mcp-server.git
cd ibmi-mcp-server
npm install
```

**2. Build the Project:**

```bash
# Build TypeScript to JavaScript
npm run build

# Or clean rebuild
npm run rebuild
```

**3. Configure Environment:**

```bash
# Copy example configuration
cp .env.example .env

# Edit with your IBM i connection details
code .env
```

**4. Run Development Server:**

```bash
# Start in HTTP mode
npm run start:http

# Start in stdio mode
npm run start:stdio
```

**5. Run Tests:**

```bash
# Run all tests
npm test

# Run in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

---

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
         "args": ["dist/index.js", "--transport", "stdio", "--tools", "tools"],
         "env": {
           "NODE_OPTIONS": "--no-deprecation",
           "DB2i_HOST": "<DB2i_HOST>",
           "DB2i_USER": "<DB2i_USER>",
           "DB2i_PASS": "<DB2i_PASS>",
           "DB2i_PORT": "<DB2i_PORT>"
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

![alt text](../docs/images/inspector.png)

5. Use the MCP Inspector to explore and test your MCP server's capabilities
   - View available tools and their parameters
   - Test queries against the server
   - Debug issues with tool execution

---

## Deployment

For production deployments with Docker, Podman, or OpenShift, see the [Deployment Guide](../deployment/README.md).

---

## 🏗️ Built With MCP TypeScript Template

This server was built using the [MCP TypeScript Template](https://github.com/cyanheads/mcp-ts-template), a production-ready foundation for building Model Context Protocol servers.

### Template Features Used

The template provided essential infrastructure that accelerated development:

- **🔌 Transport Layer** - Pre-built stdio and HTTP (Hono) transports with session management
- **🔭 Observability** - OpenTelemetry integration for distributed tracing and metrics
- **🔒 Security** - Authentication middleware (JWT, OAuth, custom), input sanitization, rate limiting
- **⚙️ Error Handling** - Structured error categorization with `BaseErrorCode` and centralized `ErrorHandler`
- **📊 Type Safety** - TypeScript + Zod validation throughout the stack
- **🧪 Testing Infrastructure** - Vitest integration with coverage reporting

### Why This Template?

The MCP TypeScript Template provided a solid architectural foundation that allowed us to focus on IBM i-specific functionality rather than building MCP infrastructure from scratch. Key benefits:

1. **Production-Ready Patterns**: "Logic Throws, Handler Catches" pattern ensures consistent error handling
2. **Modular Design**: Clear separation between core logic, handlers, and transports
3. **Enterprise Features**: Built-in observability, security, and performance monitoring
4. **Developer Experience**: Hot reloading, structured logging, and comprehensive tooling

### Customizations for IBM i

While the template provided the foundation, we added IBM i-specific capabilities:

- **Mapepire Integration** - WebSocket-based Db2 for i connectivity
- **SQL YAML Tool Configuration** - Declarative SQL tool definitions with merge capabilities
- **IBM i HTTP Authentication** - RSA/AES encrypted credential flow with connection pooling
- **SQL Tool Execution** - Parameterized query execution with result formatting
- **Toolset Management** - Dynamic tool loading and filtering by toolset

### Get Started with the Template

If you're building your own MCP server, check out the template:

```bash
# Use the template to create your own MCP server
npx degit cyanheads/mcp-ts-template my-mcp-server
cd my-mcp-server
npm install
npm run build
```