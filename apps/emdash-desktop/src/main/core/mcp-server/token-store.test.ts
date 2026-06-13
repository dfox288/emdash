import { describe, expect, it, vi } from 'vitest';
import { MCP_TOKEN_SECRET_KEY } from './constants';
// `import type` is erased at runtime, so it does not trigger the db-client
// import chain that the real encrypted store pulls in.
import type { SecretStore } from './token-store';

// The real encrypted store pulls in the db client at import time; the tests
// inject their own fake SecretStore, so stub the default singleton's module.
vi.mock('@main/core/secrets/encrypted-app-secrets-store', () => ({
  encryptedAppSecretsStore: {},
}));

const { McpTokenStore } = await import('./token-store');

function makeStore(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  const store: SecretStore = {
    getSecret: vi.fn(async (k: string) => data[k] ?? null),
    setSecret: vi.fn(async (k: string, v: string) => {
      data[k] = v;
    }),
    deleteSecret: vi.fn(async (k: string) => {
      delete data[k];
    }),
  };
  return { store, data };
}

describe('McpTokenStore', () => {
  it('generates and persists a 64-char hex token on first getOrCreate', async () => {
    const { store } = makeStore();
    const ts = new McpTokenStore(store);
    const token = await ts.getOrCreate();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.setSecret).toHaveBeenCalledTimes(1);
  });

  it('returns the same token on subsequent getOrCreate (no re-generation)', async () => {
    const { store } = makeStore();
    const ts = new McpTokenStore(store);
    const first = await ts.getOrCreate();
    const second = await ts.getOrCreate();
    expect(second).toBe(first);
    expect(store.setSecret).toHaveBeenCalledTimes(1);
  });

  it('peek returns null when absent and the value when present', async () => {
    expect(await new McpTokenStore(makeStore().store).peek()).toBeNull();
    const ts = new McpTokenStore(makeStore({ [MCP_TOKEN_SECRET_KEY]: 'abc' }).store);
    expect(await ts.peek()).toBe('abc');
  });

  it('rotate replaces the stored token with a new one', async () => {
    const { store } = makeStore();
    const ts = new McpTokenStore(store);
    const original = await ts.getOrCreate();
    const rotated = await ts.rotate();
    expect(rotated).not.toBe(original);
    expect(rotated).toMatch(/^[0-9a-f]{64}$/);
    expect(await ts.peek()).toBe(rotated);
  });

  it('clear removes the stored token', async () => {
    const ts = new McpTokenStore(makeStore({ [MCP_TOKEN_SECRET_KEY]: 'abc' }).store);
    await ts.clear();
    expect(await ts.peek()).toBeNull();
  });
});
