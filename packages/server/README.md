# IBM i MCP Server

> **Note — CLI moved.** The `ibmi` command-line interface used to ship with this package. As of v0.5.0 it's a separate package: install it with `npm i -g @ibm/ibmi-cli`. This package continues to provide the `ibmi-mcp-server` binary. See [packages/cli](../cli/README.md).

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
    - [OAuth Authentication](#oauth-authentication)
    - [IBM i HTTP Authentication](#ibm-i-http-authentication)
    - [Tool Loading](#tool-loading)
    - [Configuration Merging](#configuration-merging)
    - [Configuration Best Practices](#configuration-best-practices)
  - [Upgrading](#upgrading)
  - [🔐 IBM i HTTP Authentication (Deprecated)](#-ibm-i-http-authentication-deprecated)
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
    - [Protocol Versions and Sessions](#protocol-versions-and-sessions)
    - [CLI Options](#cli-options)
    - [Common Development Scenarios](#common-development-scenarios)
    - [Development Tips](#development-tips)
    - [Troubleshooting](#troubleshooting)
  - [🕵️‍♂️ MCP Inspector](#️️-mcp-inspector)
  - [Deployment](#deployment)
  - [🏗️ Built With MCP TypeScript Template](#️-built-with-mcp-typescript-template)

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
> **📖 More Tools:** The repository includes many ready-to-use tools in the [`tools/`](../../tools/) directory covering performance monitoring, security, job management, and more. See [SQL Tool Configuration](#-sql-tool-configuration) to create your own custom tools.

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
npx -y @ibm/ibmi-mcp-server@latest --transport http --tools ./tools/quickstart.yaml
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
  -H "Accept: application/json, text/event-stream" \
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

> **📖 Client Documentation:** See [client/README.md](../../client/README.md) for detailed setup instructions.

> [!TIP]
> **Explore More SQL Tools:** The `tools/` directory contains many ready-to-use SQL tool configurations for common IBM i tasks. Browse the collection and customize them for your needs. See the [Tools Guide](../../tools/README.md) for more details.

---

## 🎯 What's Next?

Choose your path based on what you want to accomplish:

| Path | Guide | Description |
|------|-------|-------------|
| **MCP Client Integration** | [Installing in MCP Clients](#-installing-in-mcp-clients) | Connect to Claude Desktop, VSCode, Cursor, and other MCP clients |
| **Custom SQL Tools** | [SQL Tool Configuration](#-sql-tool-configuration) | Create YAML-based SQL tools for your IBM i use cases |
| **Server Configuration** | [Configuration Guide](#️-configuration) | Explore authentication, transport modes, and environment variables |
| **Production Deployment** | [Deployment Options](../../deployment/README.md) | Deploy with Docker, Podman, or OpenShift |
| **AI Agent Development** | [IBM i Agents](#-ibm-i-agents) | Build custom AI agents that interact with IBM i systems |
| **Development & Contributing** | [Running the Server (Development)](#️-running-the-server-development) | Build from source, run tests, and contribute |

---

## CLI Reference

The IBM i MCP Server provides a command-line interface with flexible options for running and configuring the server.

### Basic Usage

```bash
npx -y @ibm/ibmi-mcp-server@latest [options]
```

> **Note:** The `-y` flag automatically accepts the npm package installation prompt.

### Available Options

| Option | Description |
|--------|-------------|
| `--tools <path>` | Path to YAML tools (file, directory, or glob pattern) |
| `--toolsets <list>` | Comma-separated list of toolsets to load |
| `--list-toolsets` | List all available toolsets and exit |
| `--transport <type>` | Transport type: `stdio` (default) or `http` |
| `--builtin-tools` | Enable built-in schema discovery tools (`list_schemas`, `list_tables_in_schema`, `get_table_columns`, `get_related_objects`, `validate_query`) |
| `--execute-sql` | Enable the `execute_sql` tool for ad-hoc queries |
| `--help` | Show help message |

<details>
<summary><strong>Common Examples</strong></summary>

**Full text-to-SQL workflow (schema discovery + query execution):**
```bash
npx -y @ibm/ibmi-mcp-server@latest --builtin-tools --execute-sql --transport http
```

**Schema discovery only (agents explore but can't run arbitrary SQL):**
```bash
npx -y @ibm/ibmi-mcp-server@latest --builtin-tools --tools ./tools
```

**Run server with YAML tools only:**
```bash
npx -y @ibm/ibmi-mcp-server@latest --transport http --tools ./tools
```

**Load specific toolsets only:**
```bash
npx -y @ibm/ibmi-mcp-server@latest --toolsets performance,security --tools ./tools
```

**List available toolsets:**
```bash
npx -y @ibm/ibmi-mcp-server@latest --list-toolsets --tools ./tools
```

</details>

---

## 🔌 Installing in MCP Clients

This server can be integrated into any MCP-compatible client using either **local** (stdio) or **remote** (HTTP) connections.

### Prerequisites: Local Installation

The server is available as an npm package and can be used directly with `npx`:

```bash
# Test the server is available
npx -y @ibm/ibmi-mcp-server@latest --help
```

> **Note:** The `-y` flag automatically accepts the npm package installation prompt.
> `TOOLS_YAML_PATH` must be an **absolute path** to your tools configuration directory (e.g., `/full/path/to/tools`).

### Remote Server Setup

For a remote server shared by several users, use **OAuth** (`MCP_AUTH_MODE=oauth`). The server verifies access tokens issued by your identity provider; it does not issue tokens itself.

1. **Start the server with OAuth enabled:**

   ```bash
   # In your .env:
   MCP_TRANSPORT_TYPE=http
   MCP_HTTP_HOST=0.0.0.0
   MCP_ALLOWED_HOSTS=mcp.example.com
   MCP_AUTH_MODE=oauth
   MCP_RESOURCE_URL=https://mcp.example.com/mcp   # public URL of the MCP endpoint
   OAUTH_ISSUER_URL=https://auth.example.com      # your authorization server

   npx -y @ibm/ibmi-mcp-server@latest --transport http --tools ./tools
   ```

2. **Configure your client with the server URL only.** A client that implements MCP authorization receives a `401` challenge, reads `/.well-known/oauth-protected-resource`, and opens a browser sign-in with your identity provider. For a client without OAuth support, obtain an access token from the identity provider and send it as `Authorization: Bearer <token>`. The remote client examples below show the `headers` form; leave the `headers` block out for an OAuth sign-in.

All SQL runs as the `DB2i_USER` service account; the token only identifies the caller. See [OAuth Authentication](#oauth-authentication) for all settings.

<details>
<summary><strong>Deprecated: IBM i token setup</strong></summary>

IBM i HTTP token authentication is deprecated and will be removed in a future major release. It still works:

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

   See [IBM i HTTP Authentication](#-ibm-i-http-authentication-deprecated) for detailed authentication setup.

3. **Configure your client** with the server URL and Bearer token (examples below).

</details>

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
  -- npx -y @ibm/ibmi-mcp-server@latest --transport stdio --tools /absolute/path/to/tools
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
# OAuth server: add the URL, then run /mcp inside Claude Code to sign in
claude mcp add --transport http ibmi-mcp https://mcp.example.com/mcp

# Fixed bearer token
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
      }
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

<details>
<summary><strong>IBM watsonx Orchestrate</strong></summary>

MCP servers can be added directly in IBM watsonx Orchestrate GUI or using the Agent Development Kit (ADK). Refer to [Adding MCP servers in IBM watsonx Orchestrate](https://www.ibm.com/docs/en/watsonx/watson-orchestrate/base?topic=tools-mcp-servers#adding-mcp-servers) for more details.

#### Local (Stdio)

It's not supported to run a local IBM i MCP server in IBM watsonx Orchestrate for now. Support will be added in a later release.

#### Remote (HTTP)

The example below shows how to add a remote IBM i MCP server in IBM watsonx Orchestrate using using the Agent Development Kit (ADK). Refer to [Adding remote MCP server in IBM watsonx Orchestrate](https://developer.watson-orchestrate.ibm.com/tools/toolkits/remote_mcp_toolkits) for more details.

1. Create **Connections** to contain the environment variables and authentication token for the MCP server

    ```bash
    # create connection for environment variables
    orchestrate connections add -a <application_id>
    orchestrate connections configure -a <application_id> --env draft -t team -k key_value
    orchestrate connections set-credentials -a application_id --env draft -e "DB2i_HOST=your-ibmi-host.com" -e "DB2i_USER=your-username" -e "DB2i_PASS=your-password" -e "DB2i_PORT=8076"
    # create connection for credential user for authentication if authentication is enabled on the MCP server
    orchestrate connections add -a <application_id>
    orchestrate connections configure -a <application_id> --env draft --type team --kind bearer
    orchestrate connections set-credentials -a <application_id> --env draft --token <bearer_token>
    ```

2. Import remote IBM i MCP server by **Importing remote MCP toolkits**

    ```bash
    orchestrate toolkits add \
    --kind mcp \
    --name <toolkit_name> \
    --description "toolkit description"  \
    --url "<mcp_url>"  \
    --transport "streamable_http" \
    --tools "*" \
    --app-id "<connection_application_id>"
    ```

3. Create an agent to use the imported toolkit

    ```bash
    orchestrate agents create \
    --name <agent_name> \
    --kind native \
    --description "agent description" \
    --llm groq/openai/gpt-oss-120b \
    --style default \
    --tools <toolkit_name> \
    --output "agent_name.agent.yaml"
    ```

> **Network Configuration for On-Premises Deployments:** If the MCP server is deployed on an on-premises IBM i system behind an enterprise firewall, proper network configuration must be implemented to ensure accessibility from IBM watsonx Orchestrate. IBM Cloud Satellite Connector provides a secure solution for this scenario by establishing connectivity between on-premises resources and IBM Cloud services. For detailed information, refer to the [IBM Cloud Satellite Connector documentation](https://cloud.ibm.com/docs/satellite?topic=satellite-understand-connectors).

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
> Set `DB2i_HOST`, `DB2i_USER`, and `DB2i_PASS` in the server `.env` file (or reference them in YAML as `${DB2i_*}`). **`DB2i_PORT`** applies to the singleton pool (built-in tools) and to YAML sources that use `port: ${DB2i_PORT}`; the example above uses literal `port: 8076`, so changing `.env` alone does not retarget YAML tools unless you switch to `${DB2i_PORT}`. Use hostname-only values for `DB2i_HOST` — do not embed `:port` in the host. See [Configuration](#️-configuration) for all available settings.

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
> **Advanced Tool Configuration:** For detailed documentation on creating custom SQL tools, parameter validation, advanced queries, and more, see [tools/README.md](../../tools/README.md).

---

## 🤖 IBM i Agents

IBM i Agents are specialized components designed to interact with the IBM i system, providing capabilities such as monitoring, management, and automation.

### Key Features
- **Integration with IBM i:** Seamless integration with IBM i system APIs and tools.
- **Modular Architecture:** Easily extendable and customizable to fit specific use cases.
- **Real-time Monitoring:** Continuous monitoring of system performance and health.

### Getting Started

Navigate to the `agents` directory and follow the setup instructions in the [README](../../agents/README.md). This includes details on configuration, running agents, and examples. Most agent examples require the MCP server to be running in HTTP mode. Read the docs for each agent example for details.

  



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
| `MCP_LOG_LEVEL` | Logging verbosity: `debug`, `info`, `notice`, `warning`, `error`, `crit`, `alert`, `emerg` | `debug` | No |
| `LOGS_DIR` | Directory for log files (absolute, `~/...`, or relative to the working directory) | `~/.ibmi-mcp-server/logs` | No |
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
MCP_LOG_LEVEL=warning
NODE_ENV=production
```

</details>

<details>
<summary><strong>🌐 HTTP Transport Settings</strong></summary>

Configuration for HTTP transport mode, including network settings and CORS. The HTTP server is stateless: it serves MCP protocol revision 2026-07-28 and earlier clients from one endpoint and has no session settings.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_HTTP_PORT` | HTTP server port | `3010` | No |
| `MCP_HTTP_HOST` | HTTP server bind address | `127.0.0.1` | No |
| `MCP_HTTP_ENDPOINT_PATH` | MCP endpoint path | `/mcp` | No |
| `MCP_HTTP_MAX_PORT_RETRIES` | Max attempts to find available port if default is in use | `15` | No |
| `MCP_HTTP_PORT_RETRY_DELAY_MS` | Delay between port retry attempts (milliseconds) | `50` | No |
| `MCP_ALLOWED_ORIGINS` | Comma-separated CORS allowed origins | None (all origins blocked) | No |
| `MCP_ALLOWED_HOSTS` | Comma-separated `Host` header allowlist (extends the always-allowed loopback set); `*` disables Host checking only, not Origin checking | None (loopback only) | No |
| `MCP_ALLOW_UNAUTHENTICATED_HTTP` | Explicitly permit unauthenticated HTTP on a non-loopback bind with IBM i credentials present | `false` | No |

**Examples:**
```bash
# Development server with CORS for local web clients (loopback-only bind)
MCP_HTTP_PORT=3010
MCP_HTTP_HOST=127.0.0.1
MCP_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173

# Production server with strict security
MCP_HTTP_PORT=443
MCP_HTTP_HOST=0.0.0.0                       # non-loopback bind requires MCP_AUTH_MODE != none
MCP_ALLOWED_HOSTS=mcp.example.com           # public hostname(s) this server is reached at
MCP_ALLOWED_ORIGINS=https://app.example.com,https://dashboard.example.com
```

</details>

<details>
<summary><strong>🛡️ Rate Limiting (HTTP Only)</strong></summary>

Controls request rate limiting for the HTTP transport. Rate limiting prevents abuse and manages server load. For agentic AI workflows with parallel tool calls, increase the limit or disable rate limiting entirely.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_RATE_LIMIT_ENABLED` | Enable or disable HTTP rate limiting | `true` | No |
| `MCP_RATE_LIMIT_MAX_REQUESTS` | Maximum requests allowed per window | `100` | No |
| `MCP_RATE_LIMIT_WINDOW_MS` | Rate limit window in milliseconds | `900000` (15 min) | No |
| `MCP_RATE_LIMIT_SKIP_DEV` | Skip rate limiting when `NODE_ENV=development` | `false` | No |

**Examples:**
```bash
# Default: 100 requests per 15 minutes
MCP_RATE_LIMIT_ENABLED=true
MCP_RATE_LIMIT_MAX_REQUESTS=100
MCP_RATE_LIMIT_WINDOW_MS=900000

# Agentic workflows: higher limit, shorter window
MCP_RATE_LIMIT_MAX_REQUESTS=1000
MCP_RATE_LIMIT_WINDOW_MS=60000

# Disable rate limiting entirely (trusted environments)
MCP_RATE_LIMIT_ENABLED=false
```

> **Docker / Reverse Proxy**: The server reads `X-Forwarded-For` and `X-Real-IP` headers for client identification. When these are absent (e.g., behind Docker without proxy header forwarding), it falls back to the TCP socket's remote address. Configure your reverse proxy to forward these headers for accurate per-client rate limiting. Authenticated requests are limited per token subject, falling back to the client id and then the IP address.

</details>

<details>
<summary><strong>🔄 Connection Pool Timeouts</strong></summary>

Controls automatic cleanup of idle Mapepire connection pools and query execution timeouts. Essential for cloud deployments (Railway, Heroku, etc.) where reverse proxies silently kill idle TCP connections, causing queries on stale WebSocket connections to hang indefinitely.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_POOL_IDLE_TIMEOUT_MS` | Idle timeout for connection pools (ms). Pools closed after inactivity. Fresh connections established automatically on next request. Set to `0` to disable. | `300000` (5 min) | No |
| `MCP_POOL_QUERY_TIMEOUT_MS` | Query execution timeout (ms). Queries aborted after this period. Pool re-initialized on next request after timeout. Set to `0` to disable. | `30000` (30s) | No |

**Examples:**
```bash
# Default: 5-minute idle timeout, 30-second query timeout
MCP_POOL_IDLE_TIMEOUT_MS=300000
MCP_POOL_QUERY_TIMEOUT_MS=30000

# Cloud deployment: shorter idle timeout for aggressive proxies
MCP_POOL_IDLE_TIMEOUT_MS=60000
MCP_POOL_QUERY_TIMEOUT_MS=30000

# Disable both timeouts (stable network environments only)
MCP_POOL_IDLE_TIMEOUT_MS=0
MCP_POOL_QUERY_TIMEOUT_MS=0
```

> **How it works:** The idle timer checks pools at an interval of `max(10s, timeout/2)`. When a pool exceeds the idle timeout, it is closed — the next query triggers transparent re-initialization via the existing lazy-init path. The query timeout wraps `pool.execute()` with `Promise.race()`, so dead connections fail fast instead of hanging. On timeout, the pool is marked unhealthy and closed for re-initialization.

</details>

<details>
<summary><strong>🔐 Authentication & Authorization</strong></summary>

Security configuration for protecting the MCP server and authenticating clients.

### General Authentication

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_AUTH_MODE` | Authentication mode for the HTTP transport: `none`, `oauth`, `ibmi` (deprecated) | `none` | No |

- `none`: no authentication. For local development and stdio (the stdio transport never authenticates).
- `oauth`: **recommended for multi-user remote deployments.**
- `ibmi`: IBM i token authentication. **Deprecated.**

The server refuses to start when any environment variable fails validation (an unknown `MCP_AUTH_MODE`, a non-numeric port, and so on): stderr names the variables at fault and the process exits with code 1.

### OAuth Authentication

Used when `MCP_AUTH_MODE=oauth`. The server is an OAuth 2.1 resource server as defined by the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): it verifies JWT access tokens issued by your authorization server and never issues tokens itself.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_RESOURCE_URL` | Public URL of the MCP endpoint as clients reach it, e.g. `https://mcp.example.com/mcp`. Tokens must be issued for it (`aud`). | None | ✅ Yes (for OAuth mode) |
| `OAUTH_ISSUER_URL` | Issuer of the authorization server. Must match the token's `iss` exactly. `https` unless loopback. | None | ✅ Yes (for OAuth mode) |
| `OAUTH_JWKS_URI` | JWKS URL used to verify token signatures. `https` unless loopback. | Discovered from the issuer's metadata (`/.well-known/oauth-authorization-server`, then `/.well-known/openid-configuration`) | No |
| `OAUTH_AUDIENCE` | Expected token audience, for authorization servers that do not put the resource URL in `aud` | `MCP_RESOURCE_URL` | No |
| `OAUTH_REQUIRED_SCOPES` | Space-separated scopes every request must carry | None | No |

What the server does in this mode:

- Requires `Authorization: Bearer <JWT>` on every request to the MCP endpoint. It checks the signature (asymmetric algorithms only), `iss`, `aud` and `exp`.
- Serves OAuth Protected Resource Metadata (RFC 9728) without a token at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource<endpoint path>`, so clients can discover the authorization server.
- Answers a missing or invalid token with `401` and a `WWW-Authenticate: Bearer ... resource_metadata="..."` challenge, and a token lacking a required scope with `403` `insufficient_scope`.
- Runs **all SQL as the `DB2i_USER` service account** (or the YAML source's user). The token identifies the caller only and is never forwarded to IBM i.

Limits: JWT access tokens only (no opaque tokens, no RFC 7662 introspection), one issuer, no per-tool scopes, no clock-skew tolerance.

Full guide: [docs/server-config/oauth.mdx](../../docs/server-config/oauth.mdx).

### IBM i HTTP Authentication

**Deprecated.** Used when `MCP_AUTH_MODE=ibmi`. See [IBM i HTTP Authentication](#-ibm-i-http-authentication-deprecated) for detailed setup.

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

# OAuth authentication (recommended for remote deployments)
MCP_AUTH_MODE=oauth
MCP_RESOURCE_URL=https://mcp.example.com/mcp
OAUTH_ISSUER_URL=https://auth.example.com
OAUTH_REQUIRED_SCOPES=mcp:tools

# IBM i authentication (deprecated; see below for keypair generation)
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
- Serve the MCP endpoint over HTTPS in production (terminate TLS at a reverse proxy)
- With the deprecated IBM i mode, **always** use `IBMI_AUTH_ALLOW_HTTP=false` in production and rotate the RSA keypair regularly

</details>

<details>
<summary><strong>🗄️ IBM i Database Connection</strong></summary>

Configuration for connecting to IBM i Db2 for i databases via Mapepire.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DB2i_HOST` | IBM i system hostname or IP address | None | ✅ Yes (for SQL tools) |
| `DB2i_USER` | IBM i user profile for database connections | None | ✅ Yes (for SQL tools) |
| `DB2i_PASS` | Password for IBM i user profile | None | ✅ Yes (for SQL tools) |
| `DB2i_PORT` | Mapepire daemon/gateway port | `8076` | No (empty/unset also defaults to `8076`) |
| `DB2i_IGNORE_UNAUTHORIZED` | Skip TLS certificate verification (for self-signed certs) | `true` | No |

**Connection Flow:**
1. Server connects to Mapepire daemon/gateway at `DB2i_HOST:DB2i_PORT`
2. Authenticates using `DB2i_USER` and `DB2i_PASS`
3. Executes SQL tools through authenticated connection pool

**`DB2i_PORT` scope:** Applies to the singleton connection pool (built-in tools such as `execute_sql`, shared credentials) and the CLI. YAML SQL tools use each source's `port` field — literal value, `${DB2i_PORT}`, or omit for Mapepire default **8076**. Shipped YAML packs use literal `8076`; env alone does not override unless the YAML references `${DB2i_PORT}`. Restart the server after changing `.env` (YAML hot-reload does not re-read env vars).

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

Settings for loading and managing SQL tools defined in YAML configuration files. See [Tools Documentation](../../tools/README.md) for YAML tool development.

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
| `YAML_ALLOW_DUPLICATE_SOURCES` | Allow duplicate source names across files (must be `true` to load the repository's whole `tools/` directory, whose files each define `ibmi-system`) | `false` | No |
| `YAML_VALIDATE_MERGED` | Validate merged configuration before loading tools | `true` | No |

**Path Resolution:**
- **File**: `TOOLS_YAML_PATH=tools/performance/performance.yaml`
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
npx @ibm/ibmi-mcp-server --tools ./my-custom-tools

# Load specific toolsets only
npx @ibm/ibmi-mcp-server --toolsets performance,security
```

</details>

<details>
<summary><strong>🛠️ Built-in Tools Configuration</strong></summary>

Settings for controlling built-in MCP tools compiled into the server. These are separate from YAML-defined tools.

## Built-in Tools Overview

The IBM i MCP Server includes built-in tools for schema discovery, query validation, and SQL execution. All built-in tools are **disabled by default** (except `describe_sql_object`) and must be explicitly enabled via CLI flags or environment variables.

| Tool | Status | Purpose | CLI Flag | Env Variable |
|------|--------|---------|----------|-------------|
| `describe_sql_object` | ✅ Always enabled | Generate DDL for database objects | — | — |
| `list_schemas` | Disabled by default | List available schemas/libraries | `--builtin-tools` | `IBMI_ENABLE_DEFAULT_TOOLS` |
| `list_tables_in_schema` | Disabled by default | List tables, views, physical files in a schema | `--builtin-tools` | `IBMI_ENABLE_DEFAULT_TOOLS` |
| `get_table_columns` | Disabled by default | Get column metadata for a table | `--builtin-tools` | `IBMI_ENABLE_DEFAULT_TOOLS` |
| `get_related_objects` | Disabled by default | Find dependent objects for impact analysis | `--builtin-tools` | `IBMI_ENABLE_DEFAULT_TOOLS` |
| `validate_query` | Disabled by default | Validate SQL syntax and verify referenced objects | `--builtin-tools` | `IBMI_ENABLE_DEFAULT_TOOLS` |
| `execute_sql` | ⚠️ Disabled by default | Execute ad-hoc SQL queries (readonly by default) | `--execute-sql` | `IBMI_ENABLE_EXECUTE_SQL` |

> **Tip:** Use `--builtin-tools --execute-sql` together for the full text-to-SQL workflow. Use `--builtin-tools` alone to let agents discover schema while routing queries through curated YAML tools.

---

### Describe SQL Object Tool

The `describe_sql_object` tool generates SQL DDL (Data Definition Language) statements for IBM i database objects using the `QSYS2.GENERATE_SQL` procedure. This tool is **always enabled** and extremely useful for providing AI models with detailed object structure information.

**Features:**
- Generates CREATE statements with full DDL syntax
- Supports all major database object types (TABLE, VIEW, INDEX, PROCEDURE, FUNCTION, etc.)
- Read-only operation - only describes objects, never modifies them
- Returns complete DDL including columns, constraints, indexes, and object-specific properties

**Supported Object Types:**
ALIAS, CONSTRAINT, FUNCTION, INDEX, MASK, PERMISSION, PROCEDURE, SCHEMA, SEQUENCE, TABLE, TRIGGER, TYPE, VARIABLE, VIEW, XSR

**Use Cases:**
- **Schema Discovery**: Help AI understand database structure before generating queries
- **Documentation**: Generate CREATE statements for version control or documentation
- **Migration**: Capture object definitions for recreating in other environments
- **Debugging**: Understand object structure when troubleshooting issues

**Example Usage:**
```json
{
  "object_name": "CUSTOMER",
  "object_library": "SALES",
  "object_type": "TABLE"
}
```

**Returns:**
```sql
CREATE TABLE SALES.CUSTOMER (
  CUSTID INTEGER NOT NULL,
  CUSTNAME VARCHAR(100),
  EMAIL VARCHAR(255),
  CREATED_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (CUSTID)
);
```

> **Note:** This tool has no configuration - it's always available as a safe, read-only operation.

---

### Execute SQL Tool

The `execute_sql` tool allows MCP clients to run ad-hoc SQL queries against your IBM i Db2 database. This tool is **disabled by default** for security reasons.

Enable via CLI flag `--execute-sql` or environment variables:

| Variable | Description | Type | Default | Required |
|----------|-------------|------|---------|----------|
| `IBMI_ENABLE_EXECUTE_SQL` | Enable the built-in `execute_sql` tool | boolean | `false` | No |
| `IBMI_EXECUTE_SQL_READONLY` | Control readonly mode (only SELECT queries) | boolean | `true` | No |

**Security Features:**
The execute_sql tool includes multiple layers of protection:
- **Read-only by default**: When `IBMI_EXECUTE_SQL_READONLY=true` (default), only SELECT/QUERY statements are allowed
- **PARSE_STATEMENT validation**: Uses IBM i's native SQL parser (`QSYS2.PARSE_STATEMENT`) to validate query syntax and statement types
- **AST/Regex validation**: Fast pattern matching to catch dangerous SQL keywords before execution
- **Write operations opt-in**: Set `IBMI_EXECUTE_SQL_READONLY=false` to explicitly enable INSERT, UPDATE, DELETE, and other write operations
- **Query length limit**: Maximum 10,000 characters per query
- **Fail-closed security**: All validation failures result in query rejection
- **Connection pooling**: Uses existing database connection pool with configured credentials

**When to Enable:**
- ✅ **Development (readonly)**: Enable with `IBMI_EXECUTE_SQL_READONLY=true` for rapid prototyping and debugging with SELECT queries
- ✅ **Development (write)**: Enable with `IBMI_EXECUTE_SQL_READONLY=false` only when you explicitly need INSERT/UPDATE/DELETE operations
- ✅ **Trusted environments**: Enable when all MCP clients are trusted
- ✅ **Read-only use cases**: Safe to enable with default readonly mode for ad-hoc query capabilities
- ❌ **Production**: Consider using YAML-defined tools with explicit, curated queries instead
- ❌ **Untrusted clients**: Keep disabled if any client might abuse query capabilities
- ❌ **Write access in production**: Never enable write mode (`IBMI_EXECUTE_SQL_READONLY=false`) in production without strict authentication and authorization

**Examples:**

```bash
# Via CLI flags (recommended for development)
npx -y @ibm/ibmi-mcp-server@latest --execute-sql --transport http
npx -y @ibm/ibmi-mcp-server@latest --builtin-tools --execute-sql --transport http

# Via environment variables
IBMI_ENABLE_EXECUTE_SQL=true
IBMI_EXECUTE_SQL_READONLY=true  # Default - only SELECT queries allowed
DB2i_HOST=ibmi-dev.local
DB2i_USER=DEVUSER
DB2i_PASS=devpass

# Enable write operations (INSERT/UPDATE/DELETE)
IBMI_ENABLE_EXECUTE_SQL=true
IBMI_EXECUTE_SQL_READONLY=false  # Allow write operations

# Production: Use YAML tools instead (more controlled)
npx -y @ibm/ibmi-mcp-server@latest --tools /opt/mcp-tools/production.yaml
```

> **⚠️ Security Recommendation:** Keep `IBMI_EXECUTE_SQL_READONLY=true` (default) unless you explicitly need write operations. For production use cases requiring write access, consider using YAML-defined tools with parameterized queries instead of ad-hoc SQL.

---

### Comparison: Built-in Tools vs YAML Tools

| Feature | Built-in Tools | YAML SQL Tools |
|---------|----------------|----------------|
| **Definition** | Compiled into server (TypeScript) | Defined in YAML files |
| **Queries** | Ad-hoc (client provides SQL) or fixed logic | Pre-defined (curated by admin) |
| **Control** | Feature flag + readonly mode | Full query + parameter control |
| **Security** | PARSE_STATEMENT + AST/Regex validation | Explicit whitelist of queries |
| **Use Case** | Development & exploration | Production & controlled access |
| **Configuration** | Environment variables | `TOOLS_YAML_PATH` |
| **Examples** | `list_schemas`, `get_table_columns`, `execute_sql`, `describe_sql_object` | Custom performance monitoring, security checks |

**Recommendation:**
- Use **`--builtin-tools`** for schema discovery — safe, read-only catalog queries that help AI understand your database
- Use **`--execute-sql`** in development for quick ad-hoc query exploration
- Use **YAML tools** in production for controlled, curated query access
- Combine **`--builtin-tools` + YAML tools** to let agents discover schema while executing only curated queries

YAML tools allow you to:
- Curate specific queries with documentation
- Control parameters and validation
- Organize tools into logical toolsets
- Provide explicit descriptions for each query

See [Tools Documentation](../../tools/README.md) for creating YAML SQL tools.

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
OTEL_SERVICE_VERSION=0.6.2
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

---

### Configuration Best Practices

**Development:**
```bash
# Recommended development .env
MCP_TRANSPORT_TYPE=http
MCP_HTTP_PORT=3010
MCP_LOG_LEVEL=debug
MCP_AUTH_MODE=none
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
MCP_LOG_LEVEL=warning
MCP_AUTH_MODE=oauth
NODE_ENV=production

MCP_RESOURCE_URL=https://mcp.example.com/mcp
OAUTH_ISSUER_URL=https://auth.example.com
OAUTH_REQUIRED_SCOPES=mcp:tools

DB2i_HOST=ibmi-prod.example.com
DB2i_USER=PRODUSER
DB2i_PASS=${SECURE_PASSWORD_FROM_VAULT}
DB2i_IGNORE_UNAUTHORIZED=false  # Require valid SSL

TOOLS_YAML_PATH=/opt/mcp-tools/production.yaml
YAML_AUTO_RELOAD=false
YAML_VALIDATE_MERGED=true

OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otlp.example.com/v1/traces
```

**Security Checklist:**
- ✅ Never commit `.env` files to version control
- ✅ Use secrets management (Vault, AWS Secrets Manager, etc.) in production
- ✅ Rotate credentials and keys regularly
- ✅ Use HTTPS/TLS in production
- ✅ Enable authentication (`MCP_AUTH_MODE=oauth`)
- ✅ Use strong passwords (12+ characters, mixed case, numbers, symbols)
- ✅ Restrict `MCP_ALLOWED_ORIGINS` to known domains

### DNS Rebinding Protection

The HTTP transport validates the `Host` and `Origin` headers of **every** request (including `/healthz` and `/api/v1/auth`) before any MCP dispatch. By default only loopback hosts (`localhost`, `127.0.0.0/8`, `::1`) are accepted; a non-wildcard `MCP_HTTP_HOST` bind address is accepted automatically, and `MCP_ALLOWED_HOSTS` **extends** the allowlist for deployments reached via a real hostname:

```bash
MCP_ALLOWED_HOSTS=mcp.example.com,mcp-internal.example.com
# Behind a proxy that rewrites Host unpredictably (logs a warning at startup):
MCP_ALLOWED_HOSTS=*
```

Requests carrying a browser `Origin` header must match `MCP_ALLOWED_ORIGINS` or resolve to an allowlisted hostname; the degenerate `Origin: null` (sandboxed iframes) is always rejected. **`MCP_ALLOWED_HOSTS=*` relaxes the `Host` check only — `Origin` is still enforced**, since a Host-rewriting proxy says nothing about which browser origins should be trusted.

**This is a browser defense, not authentication.** Host validation stops a malicious web page from driving the server via DNS rebinding — it does nothing against an attacker with direct network reach, who can forge any header. For that reason the server **refuses to start** when all of the following hold: HTTP transport, authentication not enforced, a non-loopback bind, and IBM i credentials present (via `DB2i_*` env vars **or** a tools YAML). Enable authentication, bind to loopback, or — only as an explicit, understood risk — set `MCP_ALLOW_UNAUTHENTICATED_HTTP=true`. The published Docker image binds `0.0.0.0`, so containers handed credentials without authentication will hit this guard by design.

Kubernetes liveness probes that target the pod IP will receive `403` on `/healthz`; prefer overriding the probe's Host header rather than allowlisting dynamic pod IPs:

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 3010
    httpHeaders:
      - name: Host
        value: localhost
```

## Upgrading

Breaking changes when upgrading from 0.6.x:

| Removed or changed | What to do |
|--------------------|------------|
| `MCP_SESSION_MODE`, `MCP_STATEFUL_SESSION_STALE_TIMEOUT_MS` | Remove them. The HTTP server is always stateless and issues no `Mcp-Session-Id`. A leftover `MCP_SESSION_MODE` other than `stateless` prints a warning and is ignored. |
| `MCP_AUTH_MODE=jwt`, `MCP_AUTH_SECRET_KEY`, `DEV_MCP_CLIENT_ID`, `DEV_MCP_SCOPES` | Removed; the server exits at startup with `MCP_AUTH_MODE=jwt`. Use `MCP_AUTH_MODE=oauth` with `MCP_RESOURCE_URL` and `OAUTH_ISSUER_URL`. |
| `MCP_AUTH_MODE=oauth` settings | `MCP_RESOURCE_URL` is new and required. `OAUTH_AUDIENCE` is now optional (default: `MCP_RESOURCE_URL`). With `OAUTH_JWKS_URI` unset, the JWKS is discovered from the issuer's metadata instead of assuming `<issuer>/.well-known/jwks.json`. The issuer and JWKS URLs must be `https` unless loopback. Tokens must use an asymmetric algorithm. |
| OAuth error responses | `401`/`403` in `oauth` mode are OAuth-shaped (`{"error":"invalid_token",...}` plus `WWW-Authenticate`), not JSON-RPC-shaped. |
| Invalid environment variables | The server refuses to start when any environment variable fails validation, instead of running with every setting at its default. Fix the variables reported on stderr. |
| IBM i HTTP token authentication | Deprecated, still works. Plan a move to `oauth`; note that under OAuth all SQL runs as the `DB2i_USER` service account, so per-user IBM i authority is lost. |
| `GET` / `DELETE` on the MCP endpoint | Both return `405`. The JSON info page a plain `GET /mcp` used to return is gone; use `GET /healthz` for health checks. |
| Request validation | A non-JSON `Content-Type` returns `415`. |
| `logging` capability | No longer advertised; `logging/setLevel` returns "Method not found". |
| Unloadable tools YAML | Stops startup in HTTP mode too (exit code 1). |
| `SdkContext` type from `@ibm/ibmi-mcp-server/tools` | Now the MCP TypeScript SDK v2 `ServerContext`. |

The server now runs on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) and serves MCP protocol revision 2026-07-28 and earlier clients from the same endpoint, over HTTP and stdio.

## 🔐 IBM i HTTP Authentication (Deprecated)

> **Deprecated.** IBM i HTTP token authentication (`MCP_AUTH_MODE=ibmi`, `IBMI_HTTP_AUTH_ENABLED`, `IBMI_AUTH_*`, `/api/v1/auth`, per-user pools) will be removed in a future major release. It works as described below; the server logs one deprecation warning at startup and `/api/v1/auth` responses carry a `Deprecation: true` header. Use [OAuth](#oauth-authentication) for multi-user remote deployments.
>
> **What moving to OAuth costs:** per-user IBM i authority. Here each user's SQL runs under their own IBM i profile. Under OAuth all SQL runs as the `DB2i_USER` service account, and the token only identifies the caller to the MCP server.

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
# Run from the repository root: the root .env is loaded automatically
# and relative paths (--tools, LOGS_DIR) resolve from the repository root.

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

### Protocol Versions and Sessions

The server is stateless and serves MCP protocol revision 2026-07-28 and earlier clients from one endpoint, over HTTP and stdio. There are no session modes and no `Mcp-Session-Id`. The MCP endpoint accepts `POST` only.

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
| `--builtin-tools`    |       | Enable built-in schema discovery tools (overrides `IBMI_ENABLE_DEFAULT_TOOLS`) | `--builtin-tools`                 |
| `--execute-sql`      |       | Enable the `execute_sql` tool (overrides `IBMI_ENABLE_EXECUTE_SQL`)           | `--execute-sql`                   |

### Common Development Scenarios

**1. Standard Development Server**

```bash
npm run start:http
# Server: http://localhost:3010/mcp
# Tools: tools/ (from .env)
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
- **Authentication**: Use `MCP_AUTH_MODE=oauth` for remote, multi-user access

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
         "args": ["packages/server/dist/index.js", "--transport", "stdio", "--tools", "tools"],
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
   npm run inspector
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

![alt text](../../docs/images/inspector.png)

5. Use the MCP Inspector to explore and test your MCP server's capabilities
   - View available tools and their parameters
   - Test queries against the server
   - Debug issues with tool execution

---

## Deployment

For production deployments with Docker, Podman, or OpenShift, see the [Deployment Guide](../../deployment/README.md).

---

## 🏗️ Built With MCP TypeScript Template

This server was originally built from the [MCP TypeScript Template](https://github.com/cyanheads/mcp-ts-template).
