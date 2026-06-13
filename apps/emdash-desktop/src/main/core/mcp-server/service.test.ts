import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture HTTP server start/stop without binding a real port, and stub the
// settings + token-store dependencies the service resolves against.
const h = vi.hoisted(() => ({
  starts: [] as Array<{ port: number; token: string }>,
  stops: 0,
  settingsGet: vi.fn(),
  getOrCreate: vi.fn(),
  peek: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock('./http-server', () => ({
  McpHttpServer: class {
    private boundPort = 0;
    async start(opts: { port: number; token: string }): Promise<void> {
      h.starts.push(opts);
      this.boundPort = opts.port === 0 ? 51000 : opts.port;
    }
    stop(): void {
      h.stops += 1;
    }
    getPort(): number {
      return this.boundPort;
    }
  },
}));

vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: h.settingsGet },
}));

vi.mock('./token-store', () => ({
  mcpTokenStore: { getOrCreate: h.getOrCreate, peek: h.peek, rotate: h.rotate },
}));

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { McpServerService } = await import('./service');

const ENV_KEYS = ['EMDASH_MCP_PORT', 'EMDASH_MCP_TOKEN'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  h.starts.length = 0;
  h.stops = 0;
  h.settingsGet.mockReset();
  h.getOrCreate.mockReset();
  h.peek.mockReset();
  h.rotate.mockReset();
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('McpServerService', () => {
  it('stays off when settings are disabled and no env override is set', async () => {
    h.settingsGet.mockResolvedValue({ enabled: false, port: 41973 });
    const svc = new McpServerService();
    await svc.initialize();
    expect(h.starts).toHaveLength(0);
    expect(svc.getStatus()).toMatchObject({ running: false, source: null, envOverride: false });
  });

  it('starts from settings with a keychain token', async () => {
    h.settingsGet.mockResolvedValue({ enabled: true, port: 0 });
    h.getOrCreate.mockResolvedValue('keychain-token');
    const svc = new McpServerService();
    await svc.initialize();
    expect(h.starts).toEqual([{ port: 0, token: 'keychain-token' }]);
    expect(svc.getStatus()).toMatchObject({ running: true, source: 'settings', port: 51000 });
  });

  it('env override wins over settings', async () => {
    process.env.EMDASH_MCP_PORT = '41999';
    process.env.EMDASH_MCP_TOKEN = 'x'.repeat(20);
    h.settingsGet.mockResolvedValue({ enabled: false, port: 41973 });
    const svc = new McpServerService();
    await svc.initialize();
    expect(h.starts).toEqual([{ port: 41999, token: 'x'.repeat(20) }]);
    expect(svc.getStatus()).toMatchObject({ running: true, source: 'env', envOverride: true });
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  it('refuses a partial env override (port without token)', async () => {
    process.env.EMDASH_MCP_PORT = '41999';
    h.settingsGet.mockResolvedValue({ enabled: true, port: 0 });
    const svc = new McpServerService();
    await svc.initialize();
    // Partial env config fails loud and does NOT fall back to settings.
    expect(h.starts).toHaveLength(0);
    expect(svc.getStatus().running).toBe(false);
  });

  it('does not restart when reconciled with an unchanged config', async () => {
    h.settingsGet.mockResolvedValue({ enabled: true, port: 0 });
    h.getOrCreate.mockResolvedValue('keychain-token');
    const svc = new McpServerService();
    await svc.initialize();
    await svc.reconcile();
    expect(h.starts).toHaveLength(1);
  });

  it('stops when toggled from enabled to disabled', async () => {
    h.settingsGet.mockResolvedValueOnce({ enabled: true, port: 0 });
    h.getOrCreate.mockResolvedValue('keychain-token');
    const svc = new McpServerService();
    await svc.initialize();
    expect(svc.getStatus().running).toBe(true);

    h.settingsGet.mockResolvedValueOnce({ enabled: false, port: 0 });
    await svc.reconcile();
    expect(svc.getStatus().running).toBe(false);
    expect(h.stops).toBeGreaterThanOrEqual(1);
  });

  it('rotateToken rotates the keychain token and restarts', async () => {
    h.settingsGet.mockResolvedValue({ enabled: true, port: 0 });
    h.getOrCreate.mockResolvedValueOnce('old-token').mockResolvedValueOnce('new-token');
    h.rotate.mockResolvedValue('new-token');
    const svc = new McpServerService();
    await svc.initialize();
    expect(h.starts[0].token).toBe('old-token');

    const result = await svc.rotateToken();
    expect(result).toMatchObject({ rotated: true, token: 'new-token' });
    expect(h.starts.at(-1)?.token).toBe('new-token');
  });

  it('rotateToken refuses when the env override is active', async () => {
    process.env.EMDASH_MCP_PORT = '41999';
    process.env.EMDASH_MCP_TOKEN = 'x'.repeat(20);
    const svc = new McpServerService();
    await svc.initialize();
    const result = await svc.rotateToken();
    expect(result.rotated).toBe(false);
    expect(result.reason).toMatch(/environment override/i);
    expect(h.rotate).not.toHaveBeenCalled();
  });
});
