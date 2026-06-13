# Inbound MCP Server

Lets an external orchestrator ("manager") agent drive emdash over MCP instead
of the GUI: spawn worktree-isolated task lanes, observe them, send follow-ups,
and archive them. This is the opposite direction from the consumer MCP
integration in [`mcp.md`](mcp.md) — here emdash *is* the server.

Off by default. It reflects existing controllers/operations over an MCP
transport; it introduces no new task/worktree/issue business logic.

## Main Files

- `src/main/core/mcp-server/service.ts` — lifecycle singleton (`reconcile`, status, token rotation)
- `src/main/core/mcp-server/http-server.ts` — loopback Streamable HTTP transport + auth
- `src/main/core/mcp-server/server.ts` — builds the per-request SDK `McpServer`
- `src/main/core/mcp-server/tools.ts` — the `emdash_*` tool surface
- `src/main/core/mcp-server/token-store.ts` — keychain-backed bearer token
- `src/main/core/mcp-server/controller.ts` — RPC: status, reveal/rotate token
- `src/main/core/mcp-server/constants.ts` — port/token constants (import-light)
- settings key `mcpServer` (`{ enabled, port }`) in `core/settings/schema.ts`

## Tools

| Tool | Maps to |
|---|---|
| `emdash_list_projects` | `projects/operations/getProjects` |
| `emdash_create_lane` | `taskService.createTask` → `launch` → `createConversation` (initial prompt) |
| `emdash_lane_status` | task + conversation `agentStatus`, lane-branch commits, lane PRs |
| `emdash_lane_diff` | workspace git provider (`getFullStatus` / `getFileDiff`) |
| `emdash_lane_output` | read-only PTY ring-buffer `peek` (ANSI-stripped) |
| `emdash_lane_send` | follow-up prompt into a running agent session |
| `emdash_lane_archive` | `taskService.archiveTask` |

Completion contract: a change-lane is done when `agentActivity` is `completed`
**and** an open PR exists for the lane branch.

## Enabling

Two ways, in priority order:

1. **Env override** (`EMDASH_MCP_PORT` + `EMDASH_MCP_TOKEN`) — both required;
   wins over settings; for scripted/dev use. The token is owned by the env and
   cannot be rotated from the app.
2. **Settings** (`mcpServer.enabled`, `mcpServer.port`) — the bearer token is
   generated on first enable and stored in the OS keychain (Electron
   safeStorage via `encryptedAppSecretsStore`). Surface it with
   `mcpServer.revealToken` and replace it with `mcpServer.rotateToken`.

Port `0` means an OS-assigned ephemeral port; a fixed port lets external
clients be configured once.

## Security

- Binds `127.0.0.1` only — never `0.0.0.0`.
- Rejects non-loopback `Host` headers (DNS-rebinding guard) with HTTP 421.
- Requires `Authorization: Bearer <token>` on every request, compared with
  `crypto.timingSafeEqual`.
- Stateless transport: a fresh `McpServer` per request, so concurrent clients
  don't collide on a single transport.
- Token is keychain-stored, never written to logs or config files.

## Rules

- Keep tools as thin adapters over existing controllers/operations — no new
  business logic here.
- Never bind anything but `127.0.0.1`; never weaken the Host check or the
  constant-time token comparison.
- `reconcile()` is the single lifecycle entry point — settings changes route
  through it from `core/settings/controller.ts`. Don't start/stop the HTTP
  server elsewhere.
- Lane agents spawned for headless use should run with `autoApprove` and must
  commit + open a PR to signal completion (see the manager workflow).
