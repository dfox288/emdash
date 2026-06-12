import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpHttpServer } from './http-server';

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@main/core/projects/operations/getProjects', () => ({
  getProjects: vi.fn(async () => [
    {
      type: 'local' as const,
      id: 'project-1',
      name: 'Demo Project',
      path: '/tmp/demo',
      baseRef: 'main',
      repositoryWorkspaceId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ]),
}));

vi.mock('@main/core/tasks/operations/getTasks', () => ({
  getTasks: vi.fn(async () => []),
}));

const TOKEN = 'test-token-0123456789abcdef';

function rawRequest(
  port: number,
  options: { headers?: Record<string, string>; method?: string; body?: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: options.method ?? 'POST',
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function connectClient(port: number, token: string): Promise<Client> {
  const client = new Client({ name: 'test-manager', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function firstText(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content;
  expect(content?.[0]?.type).toBe('text');
  return content![0].text;
}

describe('McpHttpServer', () => {
  let server: McpHttpServer;
  let port: number;

  beforeEach(async () => {
    server = new McpHttpServer();
    await server.start({ port: 0, token: TOKEN });
    port = server.getPort();
  });

  afterEach(() => {
    server.stop();
  });

  describe('auth', () => {
    it('rejects requests without a bearer token', async () => {
      const res = await rawRequest(port, {
        headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('rejects requests with a wrong bearer token', async () => {
      const res = await rawRequest(port, {
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: 'Bearer wrong-token-0123456789abcdef',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('rejects requests with a non-loopback Host header', async () => {
      const res = await rawRequest(port, {
        headers: {
          host: 'evil.example.com',
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(res.status).toBe(421);
    });

    it('rejects non-POST methods', async () => {
      const res = await rawRequest(port, {
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(405);
    });
  });

  describe('MCP handshake and tools', () => {
    it('lists the lane tools after a standard client handshake', async () => {
      const client = await connectClient(port, TOKEN);
      try {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        expect(names).toEqual([
          'emdash_create_lane',
          'emdash_lane_diff',
          'emdash_lane_status',
          'emdash_list_projects',
        ]);
      } finally {
        await client.close();
      }
    });

    it('serves emdash_list_projects', async () => {
      const client = await connectClient(port, TOKEN);
      try {
        const result = await client.callTool({ name: 'emdash_list_projects', arguments: {} });
        const projects = JSON.parse(firstText(result));
        expect(projects).toEqual([
          { id: 'project-1', name: 'Demo Project', path: '/tmp/demo', type: 'local' },
        ]);
      } finally {
        await client.close();
      }
    });

    it('handles two concurrent clients on the same port (stateless mode)', async () => {
      const [a, b] = await Promise.all([connectClient(port, TOKEN), connectClient(port, TOKEN)]);
      try {
        const [resA, resB] = await Promise.all([
          a.callTool({ name: 'emdash_list_projects', arguments: {} }),
          b.callTool({ name: 'emdash_list_projects', arguments: {} }),
        ]);
        expect(JSON.parse(firstText(resA))).toHaveLength(1);
        expect(JSON.parse(firstText(resB))).toHaveLength(1);
      } finally {
        await Promise.all([a.close(), b.close()]);
      }
    });

    it('rejects an unknown agent id in emdash_create_lane without touching the db', async () => {
      const client = await connectClient(port, TOKEN);
      try {
        const result = await client.callTool({
          name: 'emdash_create_lane',
          arguments: { projectId: 'project-1', prompt: 'do something', agent: 'not-an-agent' },
        });
        expect(result.isError).toBe(true);
        const payload = JSON.parse(firstText(result));
        expect(payload.error).toBe('invalid_agent');
      } finally {
        await client.close();
      }
    });

    it('returns task_not_found from emdash_lane_status for unknown tasks', async () => {
      const client = await connectClient(port, TOKEN);
      try {
        const result = await client.callTool({
          name: 'emdash_lane_status',
          arguments: { taskId: 'nope' },
        });
        expect(result.isError).toBe(true);
        const payload = JSON.parse(firstText(result));
        expect(payload.error).toBe('task_not_found');
      } finally {
        await client.close();
      }
    });
  });
});
