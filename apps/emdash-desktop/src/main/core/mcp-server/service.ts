/**
 * Lifecycle for the inbound MCP server.
 *
 * Two ways to enable it, in priority order:
 *
 *  1. Env override — `EMDASH_MCP_PORT` + `EMDASH_MCP_TOKEN`. Wins over
 *     settings; intended for scripted / dev use. The server runs with the
 *     given token on the given port and the settings toggle is ignored.
 *  2. Settings — `mcpServer.enabled` with `mcpServer.port`. The bearer token
 *     is generated and stored in the OS keychain (see token-store).
 *
 * Off by default (settings disabled, no env override). `reconcile()` is the
 * single entry point that diffs desired-vs-current and starts/stops/restarts
 * the HTTP server; the settings controller calls it on `mcpServer` changes.
 */
import { appSettingsService } from '@main/core/settings/settings-service';
import { log } from '@main/lib/logger';
import { isValidMcpPort, MCP_MIN_TOKEN_LENGTH } from './constants';
import { McpHttpServer } from './http-server';
import { mcpTokenStore } from './token-store';

export type McpServerSource = 'env' | 'settings';

type DesiredConfig = {
  /** Configured port (0 = ephemeral). May differ from the bound port. */
  port: number;
  token: string;
  source: McpServerSource;
};

export type McpServerStatus = {
  running: boolean;
  /** Actually-bound port when running, else null. */
  port: number | null;
  source: McpServerSource | null;
  /** True when the env override is active (settings toggle is then ignored). */
  envOverride: boolean;
};

export class McpServerService {
  private httpServer: McpHttpServer | null = null;
  private desired: DesiredConfig | null = null;
  private boundPort = 0;
  /** Serializes reconcile() so rapid toggles can't race start/stop. */
  private reconcileChain: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {
    await this.reconcile();
  }

  /** Recompute desired config and start/stop/restart the server to match. */
  reconcile(): Promise<void> {
    this.reconcileChain = this.reconcileChain
      .then(() => this.reconcileNow())
      .catch((e) => {
        log.error('McpServerService: reconcile failed', { error: String(e) });
      });
    return this.reconcileChain;
  }

  private async reconcileNow(): Promise<void> {
    const next = await this.resolveDesired();

    if (!next) {
      if (this.httpServer) {
        this.stop();
        log.info('McpServerService: inbound MCP server stopped');
      }
      return;
    }

    if (this.httpServer && this.desired && sameConfig(this.desired, next)) {
      return; // already running with the right config
    }

    this.stop();
    const server = new McpHttpServer();
    await server.start({ port: next.port, token: next.token });
    this.httpServer = server;
    this.desired = next;
    this.boundPort = server.getPort();
    log.info('McpServerService: inbound MCP server listening', {
      url: `http://127.0.0.1:${this.boundPort}/mcp`,
      source: next.source,
    });
  }

  private async resolveDesired(): Promise<DesiredConfig | null> {
    const envPortRaw = process.env.EMDASH_MCP_PORT;
    const envToken = process.env.EMDASH_MCP_TOKEN;
    if (envPortRaw || envToken) {
      // Partial env config is a misconfiguration — fail loud, don't fall back.
      if (!envPortRaw || !envToken) {
        log.error(
          'McpServerService: both EMDASH_MCP_PORT and EMDASH_MCP_TOKEN must be set to use the env override'
        );
        return null;
      }
      const port = Number.parseInt(envPortRaw, 10);
      if (!isValidMcpPort(port)) {
        log.error('McpServerService: invalid EMDASH_MCP_PORT', { value: envPortRaw });
        return null;
      }
      if (envToken.length < MCP_MIN_TOKEN_LENGTH) {
        log.error(
          `McpServerService: EMDASH_MCP_TOKEN too short — need at least ${MCP_MIN_TOKEN_LENGTH} characters`
        );
        return null;
      }
      return { port, token: envToken, source: 'env' };
    }

    const settings = await appSettingsService.get('mcpServer');
    if (!settings.enabled) return null;
    if (!isValidMcpPort(settings.port)) {
      log.error('McpServerService: invalid mcpServer.port setting', { value: settings.port });
      return null;
    }
    const token = await mcpTokenStore.getOrCreate();
    return { port: settings.port, token, source: 'settings' };
  }

  getStatus(): McpServerStatus {
    return {
      running: this.httpServer !== null,
      port: this.httpServer !== null ? this.boundPort : null,
      source: this.desired?.source ?? null,
      envOverride: Boolean(process.env.EMDASH_MCP_PORT && process.env.EMDASH_MCP_TOKEN),
    };
  }

  /**
   * Returns the active bearer token so the user can configure an external
   * client. Only meaningful when the server is enabled.
   */
  async revealToken(): Promise<{ token: string | null; source: McpServerSource | null }> {
    if (this.desired) return { token: this.desired.token, source: this.desired.source };
    // Not running: surface the keychain token if one exists (settings path).
    return { token: await mcpTokenStore.peek(), source: null };
  }

  /**
   * Rotates the keychain bearer token and restarts the server so the new
   * token takes effect. No-op error path when the env override is active
   * (that token is owned by the environment, not us).
   */
  async rotateToken(): Promise<{ rotated: boolean; token: string | null; reason?: string }> {
    if (process.env.EMDASH_MCP_PORT && process.env.EMDASH_MCP_TOKEN) {
      return {
        rotated: false,
        token: null,
        reason: 'Token is controlled by the EMDASH_MCP_TOKEN environment override.',
      };
    }
    const token = await mcpTokenStore.rotate();
    await this.reconcile();
    return { rotated: true, token };
  }

  stop(): void {
    this.httpServer?.stop();
    this.httpServer = null;
    this.desired = null;
    this.boundPort = 0;
  }

  dispose(): void {
    this.stop();
  }
}

function sameConfig(a: DesiredConfig, b: DesiredConfig): boolean {
  return a.port === b.port && a.token === b.token && a.source === b.source;
}

export const mcpServerService = new McpServerService();
