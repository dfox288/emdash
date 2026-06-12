import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLaneTools } from './tools';

export const MCP_SERVER_NAME = 'emdash';
export const MCP_SERVER_VERSION = '0.1.0';

/**
 * Builds a fresh SDK `McpServer` with all emdash tools registered.
 *
 * Called once per HTTP request (stateless transport mode) — the SDK couples
 * one server instance to exactly one transport, so instances must not be
 * shared across requests.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });
  registerLaneTools(server);
  return server;
}
