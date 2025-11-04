# Bob MCP Setup for IBM i Tool Development

This directory contains configuration for using Bob (the MCP-powered tool builder) to create and manage IBM i SQL tools.

## Quick Start

### 1. Create MCP Configuration File

Copy the example configuration and customize it:

```bash
cp .bob/mcp.json.example .bob/mcp.json
```

Or create a file named `mcp.json` in this `.bob/` directory with the following structure:

```json
{
  "mcpServers": {
    "ibmi-mcp-server": {
      "command": "npx",
      "args": [
        "ibmi-mcp-server"
      ],
      "cwd": "${workspaceFolder}",
      "env": {
        "TOOLS_YAML_PATH": ".bob/tools/services-tools.yaml",
        "NODE_OPTIONS": "--no-deprecation",
        "DB2i_HOST": "${DB2i_HOST}",
        "DB2i_USER": "${DB2i_USER}",
        "DB2i_PASS": "${DB2i_PASS}",
        "DB2i_PORT": "${DB2i_PORT}",
        "MCP_TRANSPORT_TYPE": "stdio"
      },
      "disabled": false,
      "alwaysAllow": []
    },
    "ibmi-mcp-docs": {
      "type": "streamable-http",
      "url": "https://ibm-d95bab6e.mintlify.app/mcp"
    }
  }
}
```

### 2. Set Up Environment Variables

Bob uses environment variable references (`${VAR_NAME}`) that need to be defined.

```bash
export DB2i_HOST="your-ibmi-hostname.com"
export DB2i_USER="your-username"
export DB2i_PASS="your-password"
export DB2i_PORT="8076"
```

**Replace these values:**

- **`DB2i_HOST`**: Your IBM i system hostname or IP address
- **`DB2i_USER`**: Your IBM i user profile
- **`DB2i_PASS`**: Your IBM i password
- **`DB2i_PORT`**: Your IBM i Mapepire database port (default: 8076)

**Security Note**: Environment variables keep credentials out of configuration files. The `mcp.json` file is gitignored to avoid committing sensitive data.

### 3. Install the Server Package (If Using npx)

The template uses `npx ibmi-mcp-server` which requires the package to be installed:

```bash
cd ibmi-mcp-server
npm install
npm run build
```

## Using Bob to Create Tools

Once configured, Bob can help you:

1. **Create new SQL tool definitions** in YAML format
2. **Validate tool configurations** against the schema
3. **Test tools** against your IBM i system
4. **Generate documentation** for your tools

Bob has access to:
- The complete IBM i MCP server codebase
- YAML configuration schemas and validation
- Example tools in `tools/`
- Direct execution capabilities on your IBM i system (via the MCP server)
- Live IBM i MCP Server documentation (via `ibmi-mcp-docs` server)

### MCP Servers in Configuration

The `mcp.json` includes two MCP servers:

1. **`ibmi-mcp-server`**: Your local development server
   - Executes SQL queries against your IBM i system
   - Loads tools from `TOOLS_YAML_PATH` (default: `.bob/tools/services-tools.yaml`)
   - Uses `npx ibmi-mcp-server` to run the server
   - Set `"disabled": false` to enable (or `true` to disable)

2. **`ibmi-mcp-docs`**: Live documentation server (experimental)
   - Provides up-to-date documentation via HTTP MCP transport
   - URL: `https://ibm-d95bab6e.mintlify.app/mcp`
   - Bob can query this for the latest API docs and examples

## Tool Development Workflow

### Creating a New Tool with Bob

1. Tell Bob what you want to query from IBM i
2. Bob will create the YAML configuration
3. Bob can validate it: `npm run validate -- --tools path/to/your-tool.yaml`
4. Bob can test it by calling the tool through the MCP server
5. Iterate on the tool definition based on results

### Example Request

> "Create a tool that lists all active jobs for a specific user on IBM i, with parameters for the username and maximum results to return."

Bob will generate the YAML, validate it, and can test it against your connected IBM i system.

## Directory Structure

```
.bob/
├── README.md                    # This file - setup instructions
├── mcp.json.example             # Template configuration (committed)
├── mcp.json                     # Your actual configuration (not committed)
└── tools/                       # Your custom tool definitions (not committed)
    └── services-tools.yaml      # Example: Service-related tools (referenced in mcp.json)
```

**Note**: The `TOOLS_YAML_PATH` in `mcp.json` points to `.bob/tools/services-tools.yaml` which comes predefined with tools for helping Bob create more tools.

## Validation

All tool configurations must pass validation before deployment:

```bash
# Validate a single file
npm run validate -- --tools path/to/tool.yaml

# Validate a directory of YAML files
npm run validate -- --tools-dir path/to/tools/

# Validate with verbose output
npm run validate -- --tools-dir path/to/tools/ --verbose
```

The validator checks:
- ✅ JSON schema compliance
- ✅ Cross-file source references (tools → sources)
- ✅ Cross-file toolset references (toolsets → tools)
- ✅ Parameter type definitions
- ✅ Required field presence

## Best Practices

1. **Always validate** before deploying: `npm run validate -- --tools-dir path/`
2. **Use meaningful names** for tools, parameters, and sources
3. **Document parameters** with clear descriptions and examples
4. **Group related tools** into logical toolsets
5. **Test incrementally** - validate and test each tool as you build it
6. **Use named parameters** (`:param_name`) not positional (`?`)
7. **Default to read-only** - use `readOnly: true` unless modification is required