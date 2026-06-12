import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConversationsForTask } from '@main/core/conversations/getConversationsForTask';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { getTasks } from '@main/core/tasks/operations/getTasks';
import { taskService } from '@main/core/tasks/task-service';
import type { Conversation } from '@shared/core/conversations/conversations';
import type { Task } from '@shared/core/tasks/tasks';
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

vi.mock('@main/core/conversations/getConversationsForTask', () => ({
  getConversationsForTask: vi.fn(async () => []),
}));

vi.mock('@main/core/pty/pty-session-registry', () => ({
  ptySessionRegistry: { peek: vi.fn(), get: vi.fn() },
}));

vi.mock('@main/core/tasks/task-service', () => ({
  taskService: { archiveTask: vi.fn(async () => undefined) },
}));

const mockGetTasks = vi.mocked(getTasks);
const mockGetConversations = vi.mocked(getConversationsForTask);
const mockPeek = vi.mocked(ptySessionRegistry.peek);
const mockGetPty = vi.mocked(ptySessionRegistry.get);
const mockArchiveTask = vi.mocked(taskService.archiveTask);

const demoTask: Task = {
  id: 'task-1',
  projectId: 'project-1',
  name: 'demo-lane',
  status: 'in_progress',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  statusChangedAt: '2026-01-01T00:00:00Z',
  isPinned: false,
  prs: [],
  conversations: {},
  type: 'task',
};

const demoConversation: Conversation = {
  id: 'conv-1',
  projectId: 'project-1',
  taskId: 'task-1',
  providerId: 'claude',
  title: 'demo-lane',
  lastInteractedAt: null,
  isInitialConversation: true,
};

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
    mockGetTasks.mockResolvedValue([]);
    mockGetConversations.mockResolvedValue([]);
    mockPeek.mockReturnValue(undefined);
    mockGetPty.mockReturnValue(undefined);
    mockArchiveTask.mockClear();
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
          'emdash_lane_archive',
          'emdash_lane_diff',
          'emdash_lane_output',
          'emdash_lane_send',
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

    it('includes prs and commits in emdash_lane_status', async () => {
      mockGetTasks.mockResolvedValue([demoTask]);
      mockGetConversations.mockResolvedValue([demoConversation]);

      const client = await connectClient(port, TOKEN);
      try {
        const result = await client.callTool({
          name: 'emdash_lane_status',
          arguments: { taskId: 'task-1' },
        });
        const payload = JSON.parse(firstText(result));
        expect(payload).toMatchObject({
          taskId: 'task-1',
          prs: [],
          // No workspaceId on the demo task → commit lookup is skipped.
          commits: null,
        });
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

  describe('lane output / send / archive', () => {
    it('returns ANSI-stripped ring buffer output from emdash_lane_output', async () => {
      mockGetTasks.mockResolvedValue([demoTask]);
      mockGetConversations.mockResolvedValue([demoConversation]);
      mockPeek.mockReturnValue('\x1b[31mhello\x1b[0m world\x1b]0;title\x07!');
      mockGetPty.mockReturnValue({} as never);

      const client = await connectClient(port, TOKEN);
      try {
        const result = await client.callTool({
          name: 'emdash_lane_output',
          arguments: { taskId: 'task-1' },
        });
        const payload = JSON.parse(firstText(result));
        expect(payload).toMatchObject({
          conversationId: 'conv-1',
          running: true,
          truncated: false,
          output: 'hello world!',
        });
        expect(mockPeek).toHaveBeenCalledWith('project-1:task-1:conv-1');
      } finally {
        await client.close();
      }
    });

    it('fails emdash_lane_output when no session buffer exists', async () => {
      mockGetTasks.mockResolvedValue([demoTask]);
      mockGetConversations.mockResolvedValue([demoConversation]);

      const client = await connectClient(port, TOKEN);
      try {
        const result = await client.callTool({
          name: 'emdash_lane_output',
          arguments: { taskId: 'task-1' },
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(firstText(result)).error).toBe('no_session_output');
      } finally {
        await client.close();
      }
    });

    it('writes the prompt plus submit sequence via emdash_lane_send', async () => {
      const write = vi.fn();
      mockGetTasks.mockResolvedValue([demoTask]);
      mockGetConversations.mockResolvedValue([demoConversation]);
      mockGetPty.mockReturnValue({ write } as never);

      const client = await connectClient(port, TOKEN);
      try {
        const result = await client.callTool({
          name: 'emdash_lane_send',
          arguments: { taskId: 'task-1', prompt: 'fix the review comments' },
        });
        const payload = JSON.parse(firstText(result));
        expect(payload).toMatchObject({ sent: true, conversationId: 'conv-1' });
        // Two writes: the pasted prompt, then — after a settle delay — the
        // submit sequence (a same-write Enter gets swallowed by agent TUIs).
        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[0][0]).toContain('fix the review comments');
        expect(write.mock.calls[1][0]).toBe('\r');
      } finally {
        await client.close();
      }
    });

    it('fails emdash_lane_send when the session is not running', async () => {
      mockGetTasks.mockResolvedValue([demoTask]);
      mockGetConversations.mockResolvedValue([demoConversation]);

      const client = await connectClient(port, TOKEN);
      try {
        const result = await client.callTool({
          name: 'emdash_lane_send',
          arguments: { taskId: 'task-1', prompt: 'hello' },
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(firstText(result)).error).toBe('lane_not_running');
      } finally {
        await client.close();
      }
    });

    it('archives a lane via emdash_lane_archive', async () => {
      mockGetTasks.mockResolvedValue([demoTask]);

      const client = await connectClient(port, TOKEN);
      try {
        const result = await client.callTool({
          name: 'emdash_lane_archive',
          arguments: { taskId: 'task-1' },
        });
        const payload = JSON.parse(firstText(result));
        expect(payload).toMatchObject({ taskId: 'task-1', archived: true });
        expect(mockArchiveTask).toHaveBeenCalledWith('project-1', 'task-1');
      } finally {
        await client.close();
      }
    });

    it('is idempotent for already-archived lanes', async () => {
      mockGetTasks.mockResolvedValue([{ ...demoTask, archivedAt: '2026-01-02T00:00:00Z' }]);

      const client = await connectClient(port, TOKEN);
      try {
        const result = await client.callTool({
          name: 'emdash_lane_archive',
          arguments: { taskId: 'task-1' },
        });
        const payload = JSON.parse(firstText(result));
        expect(payload).toMatchObject({ archived: true, alreadyArchived: true });
        expect(mockArchiveTask).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    });
  });
});
