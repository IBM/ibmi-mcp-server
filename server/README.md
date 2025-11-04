# IBM i MCP Server

The Model Context Protocol (MCP) server for IBM i systems.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run server (HTTP mode)
npm run start:http

# Run server (stdio mode)
npm run start:stdio

# Run tests
npm test
```

## Configuration

Create a `.env` file in the **root of the monorepo** (parent directory):

```bash
cp ../.env.example ../.env
```

The server will automatically detect configuration in:

1. Current working directory (for production deployments)
2. Parent directory (for monorepo development)
3. Server directory (for local overrides)

## Tool Configuration

By default, the server loads SQL tools from `../tools/`. Override with:

```bash
TOOLS_YAML_PATH=../tools npm run start:http
```

Or set in your `.env` file:

```ini
TOOLS_YAML_PATH=tools
```

## Documentation

See the [root README](../README.md) for complete documentation and deployment guides.

## Development

This is the main server package within the monorepo. All server development happens here.

- **Source**: `src/`
- **Tests**: `tests/`
- **Scripts**: `scripts/`
- **Build Output**: `dist/`

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
- `../apps/` - Deployment configurations (Docker, Gateway, n8n)
