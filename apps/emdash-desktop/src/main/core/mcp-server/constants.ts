/**
 * Light constants for the inbound MCP server — safe to import from settings
 * wiring without pulling in the MCP SDK / tool graph.
 */

/** Default loopback port the inbound MCP server binds when enabled via settings. */
export const MCP_SERVER_DEFAULT_PORT = 41973;

/** Minimum bearer-token length accepted (env override) / generated (keychain). */
export const MCP_MIN_TOKEN_LENGTH = 16;

/** Keychain key under which the generated bearer token is stored. */
export const MCP_TOKEN_SECRET_KEY = 'mcp-server.bearer-token';

/** A port value of 0 means "let the OS pick an ephemeral port". */
export function isValidMcpPort(port: number): boolean {
  return Number.isInteger(port) && (port === 0 || (port >= 1024 && port <= 65535));
}
