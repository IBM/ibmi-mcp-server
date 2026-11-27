/**
 * @fileoverview The CLI runs the server's tool logic in its own process, on
 * the connection of the system it was asked for. How the MCP server
 * authenticates its HTTP clients (`MCP_AUTH_MODE` and the settings that go
 * with it, often in the `.env` file of the directory the CLI is started in)
 * says nothing about that connection. Left in the environment,
 * `MCP_AUTH_MODE=oauth` would make the server modules refuse every statement
 * for want of a sign-on, or reject the whole environment as incomplete.
 *
 * Imported for its effect, before anything of `@ibm/ibmi-mcp-server`: the
 * server reads the environment when its configuration module is loaded, and
 * a `.env` file does not replace a variable that is already set.
 * @module cli/serverAuthMode
 */

process.env.MCP_AUTH_MODE = "none";
