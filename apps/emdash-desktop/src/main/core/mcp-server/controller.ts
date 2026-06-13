import { createRPCController } from '@shared/lib/ipc/rpc';
import { mcpServerService, type McpServerStatus, type McpServerSource } from './service';

/**
 * RPC surface for the inbound MCP server. Status + token management; the
 * enable/disable toggle and port live in app settings (`mcpServer`), which
 * the settings controller reconciles into the service.
 */
export const mcpServerController = createRPCController({
  getStatus: async (): Promise<McpServerStatus> => mcpServerService.getStatus(),

  /** Surface the active bearer token so the user can configure a client. */
  revealToken: async (): Promise<{ token: string | null; source: McpServerSource | null }> =>
    mcpServerService.revealToken(),

  /** Rotate the keychain token and restart so it takes effect. */
  rotateToken: async (): Promise<{ rotated: boolean; token: string | null; reason?: string }> =>
    mcpServerService.rotateToken(),
});
