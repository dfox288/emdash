# MCP

Emdash integrates with MCP in **two directions**:

- **Outbound / consumer** (this document): emdash configures which external MCP
  servers the *agents* it launches connect to.
- **Inbound / server** (see [`mcp-server.md`](mcp-server.md)): emdash itself
  exposes an MCP server so an external orchestrator agent can drive emdash
  (create task lanes, read status/diffs, send follow-ups, archive). Off by
  default.

The two are independent subsystems (`core/mcp/` vs `core/mcp-server/`).

## Main Files

- `src/main/core/mcp/services/McpService.ts`
- `src/main/core/mcp/utils/` — adapters, catalog, config IO, config paths, conversion
- `src/main/core/mcp/controller.ts`
- `src/shared/mcp/`
- `src/renderer/features/mcp/` (`mcp-view.tsx`, `components/`)

## Current Behavior

- MCP server configs are read, adapted, merged, and written across supported agent ecosystems
- provider-specific config formats are handled through adapters in `src/main/core/mcp/utils/`
- the renderer MCP UI manages installed servers and catalog entries

## Rules

- do not assume all providers support the same MCP transport types
- keep canonical MCP data in shared types and adapt at the edges
- if you add provider-specific MCP behavior, update both service and UI compatibility handling
