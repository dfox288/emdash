/**
 * Loopback-only HTTP gateway for the inbound MCP server (POC).
 *
 * Speaks the MCP Streamable HTTP transport in stateless mode: every POST
 * mints a fresh SDK `McpServer` + transport pair (the SDK couples one server
 * instance to one transport, so per-request instances avoid the "already
 * connected to a transport" failure mode under concurrent clients).
 *
 * Security posture (mirrors `agent-hooks/hook-server.ts` + PR #2055):
 * - Binds 127.0.0.1 only — never 0.0.0.0.
 * - Rejects non-loopback Host headers with 421 (DNS-rebinding guard).
 * - Requires `Authorization: Bearer <token>` on every request, compared
 *   with `crypto.timingSafeEqual`.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { log } from '@main/lib/logger';
import { buildMcpServer } from './server';

const MAX_BODY_BYTES = 4_000_000;
const MCP_PATH = '/mcp';

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function handleMcpPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsedBody: unknown;
  try {
    parsedBody = body.length > 0 ? JSON.parse(body) : undefined;
  } catch {
    writeJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
    return;
  }

  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    // Stateless mode: no session ids, every request is self-contained.
    sessionIdGenerator: undefined,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

export type McpHttpServerOptions = {
  port: number;
  token: string;
};

export class McpHttpServer {
  private server: http.Server | null = null;
  private port = 0;

  async start(options: McpHttpServerOptions): Promise<void> {
    if (this.server) return;
    const { port, token } = options;

    this.server = http.createServer((req, res) => {
      if (!isAllowedHost(req.headers.host, this.port)) {
        log.warn('McpHttpServer: rejected request with non-loopback Host header');
        res.writeHead(421);
        res.end();
        return;
      }

      const bearer = extractBearerToken(req);
      if (bearer === null || !timingSafeEqualStr(bearer, token)) {
        log.warn('McpHttpServer: rejected request with missing/invalid bearer token');
        writeJson(res, 401, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        });
        return;
      }

      if (req.url !== MCP_PATH) {
        res.writeHead(404);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        // Stateless mode: no SSE notification stream (GET) and no session
        // teardown (DELETE) — both are optional per the MCP spec.
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }

      handleMcpPost(req, res).catch((error) => {
        log.error('McpHttpServer: request handling failed', { error: String(error) });
        if (!res.headersSent) {
          writeJson(res, 500, {
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          });
        } else {
          res.end();
        }
      });
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        log.info('McpHttpServer: started', { port: this.port });
        resolve();
      });
      this.server!.on('error', (err) => {
        log.error('McpHttpServer: failed to start', { error: String(err) });
        reject(err);
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
    }
  }

  getPort(): number {
    return this.port;
  }
}
