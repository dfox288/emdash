/**
 * Bearer-token store for the inbound MCP server.
 *
 * The token is persisted via the encrypted app-secrets store (OS keychain
 * through Electron safeStorage), never in plaintext config or logs. It is
 * generated lazily on first enable and only surfaced over IPC on explicit,
 * user-initiated reveal/rotation.
 */
import { randomBytes } from 'node:crypto';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { MCP_TOKEN_SECRET_KEY } from './constants';

/** 32 random bytes as hex → 64-char token. */
function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export interface SecretStore {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, secret: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export class McpTokenStore {
  constructor(private readonly store: SecretStore = encryptedAppSecretsStore) {}

  /** Returns the stored token, or null if none has been generated yet. */
  async peek(): Promise<string | null> {
    return this.store.getSecret(MCP_TOKEN_SECRET_KEY);
  }

  /** Returns the stored token, generating and persisting one if absent. */
  async getOrCreate(): Promise<string> {
    const existing = await this.store.getSecret(MCP_TOKEN_SECRET_KEY);
    if (existing) return existing;
    const token = generateToken();
    await this.store.setSecret(MCP_TOKEN_SECRET_KEY, token);
    return token;
  }

  /** Generates a fresh token, replacing any existing one. */
  async rotate(): Promise<string> {
    const token = generateToken();
    await this.store.setSecret(MCP_TOKEN_SECRET_KEY, token);
    return token;
  }

  /** Removes the stored token (e.g. on a hard reset). */
  async clear(): Promise<void> {
    await this.store.deleteSecret(MCP_TOKEN_SECRET_KEY);
  }
}

export const mcpTokenStore = new McpTokenStore();
