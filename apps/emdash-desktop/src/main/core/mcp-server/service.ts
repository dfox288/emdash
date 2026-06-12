/**
 * Lifecycle singleton for the inbound MCP server (POC).
 *
 * POC gating: the server only starts when BOTH `EMDASH_MCP_PORT` and
 * `EMDASH_MCP_TOKEN` are set in the environment — i.e. it is off by default
 * and there is no UI surface yet. The full feature replaces this with a
 * settings toggle plus a token in the encrypted app-secrets store.
 *
 * Example:
 *   EMDASH_MCP_PORT=41973 EMDASH_MCP_TOKEN=$(openssl rand -hex 24) pnpm run dev
 */
import { log } from '@main/lib/logger';
import { McpHttpServer } from './http-server';

const MIN_TOKEN_LENGTH = 16;

export class McpServerService {
  private httpServer: McpHttpServer | null = null;

  async initialize(): Promise<void> {
    const portRaw = process.env.EMDASH_MCP_PORT;
    const token = process.env.EMDASH_MCP_TOKEN;

    if (!portRaw || !token) {
      log.debug('McpServerService: disabled (EMDASH_MCP_PORT / EMDASH_MCP_TOKEN not set)');
      return;
    }

    const port = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      log.error('McpServerService: invalid EMDASH_MCP_PORT — expected an integer in 1024-65535', {
        value: portRaw,
      });
      return;
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      log.error(
        `McpServerService: EMDASH_MCP_TOKEN too short — need at least ${MIN_TOKEN_LENGTH} characters`
      );
      return;
    }

    this.httpServer = new McpHttpServer();
    await this.httpServer.start({ port, token });
    log.info('McpServerService: inbound MCP server listening', {
      url: `http://127.0.0.1:${port}/mcp`,
    });
  }

  dispose(): void {
    this.httpServer?.stop();
    this.httpServer = null;
  }
}

export const mcpServerService = new McpServerService();
