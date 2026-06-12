/**
 * POC tool surface for the inbound MCP server — the "manager loop":
 *
 *   emdash_list_projects → getProjects            (projects/operations/getProjects.ts)
 *   emdash_create_lane   → taskService.createTask → taskService.launch →
 *                          createConversation      (the proven automations sequence,
 *                          see automations/actions/taskCreate.ts)
 *   emdash_lane_status   → getTasks + getConversationsForTask (agentStatus)
 *   emdash_lane_diff     → workspace git provider (getFullStatus / getFileDiff)
 *
 * No business logic lives here — every tool validates args and calls existing
 * operations. Runtime deps are imported lazily inside the handlers so that
 * constructing an `McpServer` (e.g. in tests) does not pull in Electron or
 * the database client.
 */
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Conversation } from '@shared/core/conversations/conversations';
import type { Branch, BranchesPayload, DiffResult } from '@shared/core/git/git';
import { buildWorkspaceConfigFromPreset } from '@shared/core/workspaces/build-workspace-config-from-preset';

// ─── Reply helpers ──────────────────────────────────────────────────────────

type ToolReply = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function ok(payload: unknown): ToolReply {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(code: string, message: string, detail?: unknown): ToolReply {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, message, detail }, null, 2) }],
    isError: true,
  };
}

// ─── Shared lookups ─────────────────────────────────────────────────────────

async function ensureProjectOpen(projectId: string) {
  const { projectManager } = await import('@main/core/projects/project-manager');
  const { openProject } = await import('@main/core/projects/operations/openProject');

  let project = projectManager.getProject(projectId);
  if (!project) {
    const openResult = await openProject(projectId);
    if (!openResult.success) return null;
    project = projectManager.getProject(projectId);
  }
  return project ?? null;
}

function resolveDefaultBranch(payload: BranchesPayload): Branch | undefined {
  const byName = (name: string | null) =>
    payload.branches.find((b) => b.type === 'local' && b.branch === name) ??
    payload.branches.find((b) => b.branch === name);
  return byName(payload.gitDefaultBranch) ?? byName(payload.currentBranch);
}

async function findTask(taskId: string) {
  const { getTasks } = await import('@main/core/tasks/operations/getTasks');
  const all = await getTasks();
  return all.find((t) => t.id === taskId) ?? null;
}

type AgentActivity = 'working' | 'needs_input' | 'error' | 'completed' | 'idle' | 'none';

function deriveAgentActivity(conversations: Conversation[]): AgentActivity {
  const statuses = conversations
    .map((c) => c.agentStatus)
    .filter((s): s is NonNullable<typeof s> => s != null);
  if (statuses.includes('awaiting-input')) return 'needs_input';
  if (statuses.includes('working')) return 'working';
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('completed')) return 'completed';
  return statuses.length === 0 ? 'none' : 'idle';
}

function renderUnifiedDiff(diff: DiffResult): string {
  if (diff.isBinary) return '<binary file>';
  return diff.lines
    .map((line) => {
      if (line.type === 'add') return `+${line.right ?? ''}`;
      if (line.type === 'del') return `-${line.left ?? ''}`;
      return ` ${line.left ?? line.right ?? ''}`;
    })
    .join('\n');
}

// ─── Tool registration ──────────────────────────────────────────────────────

export function registerLaneTools(server: McpServer): void {
  // emdash_list_projects ────────────────────────────────────────────────────
  server.registerTool(
    'emdash_list_projects',
    {
      title: 'List projects',
      description:
        'List all projects registered in emdash. Use the returned id as projectId for the other tools.',
      inputSchema: {},
    },
    async (): Promise<ToolReply> => {
      const { getProjects } = await import('@main/core/projects/operations/getProjects');
      const projects = await getProjects();
      return ok(projects.map((p) => ({ id: p.id, name: p.name, path: p.path, type: p.type })));
    }
  );

  // emdash_create_lane ──────────────────────────────────────────────────────
  const createLaneInput = {
    projectId: z.string().describe('Project to create the lane in (see emdash_list_projects).'),
    prompt: z.string().min(1).describe('Initial prompt the agent starts working on.'),
    name: z
      .string()
      .optional()
      .describe('Task name; derived from the prompt when omitted. Also used as branch name.'),
    agent: z
      .string()
      .optional()
      .describe("Agent provider id (e.g. 'claude', 'codex'). Defaults to the app default agent."),
    autoApprove: z
      .boolean()
      .optional()
      .describe('Let the agent run without per-action approval prompts. Defaults to false.'),
  };
  server.registerTool(
    'emdash_create_lane',
    {
      title: 'Create lane',
      description:
        'Create an isolated task lane: a git worktree on a fresh branch plus an agent session ' +
        'started on the given prompt. Returns ids for polling status and reading the diff back.',
      inputSchema: createLaneInput,
    },
    async (args): Promise<ToolReply> => {
      // Validate the agent id before importing anything heavy — the shared
      // registry is pure, while the modules below pull in the db client.
      const { isValidProviderId } = await import('@shared/core/agents/agent-provider-registry');
      if (args.agent !== undefined && !isValidProviderId(args.agent)) {
        return fail('invalid_agent', `Unknown agent provider id: ${args.agent}`);
      }

      const { appSettingsService } = await import('@main/core/settings/settings-service');
      const { DEFAULT_AGENT_ID } = await import('@main/core/settings/settings-registry');
      const { generateTaskName } =
        await import('@main/core/tasks/name-generation/generateTaskName');
      const { taskService } = await import('@main/core/tasks/task-service');
      const { createConversation } = await import('@main/core/conversations/createConversation');

      const provider =
        args.agent ?? (await appSettingsService.get('defaultAgent')) ?? DEFAULT_AGENT_ID;
      if (!isValidProviderId(provider)) {
        return fail('invalid_agent', `Resolved agent provider id is invalid: ${provider}`);
      }

      const project = await ensureProjectOpen(args.projectId);
      if (!project) {
        return fail('project_not_found', `Project not found or failed to open: ${args.projectId}`);
      }

      const branchesPayload = await project.repository.getBranchesPayload();
      if (branchesPayload.isUnborn) {
        return fail(
          'initial_commit_required',
          'The project repository has no commits yet — create an initial commit first.'
        );
      }
      const defaultBranch = resolveDefaultBranch(branchesPayload);
      if (!defaultBranch) {
        return fail('default_branch_not_found', 'Could not resolve a default branch to fork from.');
      }

      const taskName = generateTaskName({ title: args.name ?? args.prompt });
      const workspaceConfig = buildWorkspaceConfigFromPreset(
        'new-worktree',
        { defaultBranch },
        // POC: keep the branch local — pushing happens via the PR flow later.
        { branchName: taskName, pushBranch: false }
      );

      const taskId = randomUUID();
      const created = await taskService.createTask({
        id: taskId,
        projectId: args.projectId,
        taskConfig: { version: '1', name: taskName },
        workspaceConfig,
      });
      if (!created.success) {
        return fail('create_task_failed', 'Task creation failed.', created.error);
      }

      const launched = await taskService.launch(taskId);
      if (!launched.success) {
        return fail('provision_failed', 'Workspace provisioning failed.', launched.error);
      }

      const conversation = await createConversation({
        id: randomUUID(),
        projectId: args.projectId,
        taskId,
        provider,
        title: taskName,
        autoApprove: args.autoApprove ?? false,
        initialPrompt: args.prompt,
        isInitialConversation: true,
      });

      return ok({
        taskId,
        conversationId: conversation.id,
        workspaceId: launched.data.workspaceId,
        worktreePath: launched.data.path,
        branchName: taskName,
        agent: provider,
      });
    }
  );

  // emdash_lane_status ──────────────────────────────────────────────────────
  const laneStatusInput = {
    taskId: z.string().describe('Task id returned by emdash_create_lane.'),
  };
  server.registerTool(
    'emdash_lane_status',
    {
      title: 'Lane status',
      description:
        'Get lane state: task lifecycle status plus derived agent activity ' +
        '(working | needs_input | error | completed | idle | none).',
      inputSchema: laneStatusInput,
    },
    async (args): Promise<ToolReply> => {
      const task = await findTask(args.taskId);
      if (!task) return fail('task_not_found', `Task not found: ${args.taskId}`);

      const { getConversationsForTask } =
        await import('@main/core/conversations/getConversationsForTask');
      const conversations = await getConversationsForTask(task.projectId, task.id);

      return ok({
        taskId: task.id,
        name: task.name,
        lifecycleStatus: task.status,
        agentActivity: deriveAgentActivity(conversations),
        workspaceId: task.workspaceId ?? null,
        conversations: conversations.map((c) => ({
          id: c.id,
          provider: c.providerId,
          agentStatus: c.agentStatus ?? null,
          lastInteractedAt: c.lastInteractedAt,
        })),
      });
    }
  );

  // emdash_lane_diff ────────────────────────────────────────────────────────
  const laneDiffInput = {
    taskId: z.string().describe('Task id returned by emdash_create_lane.'),
    filePath: z
      .string()
      .optional()
      .describe(
        'When set, return the unified diff for this file (relative to the worktree root). ' +
          'Omit to get the change summary for the whole lane.'
      ),
  };
  server.registerTool(
    'emdash_lane_diff',
    {
      title: 'Lane diff',
      description:
        'Read the changes an agent produced in a lane. Without filePath: per-file change summary ' +
        '(status, additions, deletions). With filePath: the unified diff of that file vs HEAD.',
      inputSchema: laneDiffInput,
    },
    async (args): Promise<ToolReply> => {
      const task = await findTask(args.taskId);
      if (!task) return fail('task_not_found', `Task not found: ${args.taskId}`);
      if (!task.workspaceId) {
        return fail('workspace_not_provisioned', 'The lane has no provisioned workspace yet.');
      }

      const { resolveWorkspace } = await import('@main/core/projects/utils');
      const env = resolveWorkspace(task.projectId, task.workspaceId);
      if (!env) {
        return fail('workspace_not_found', `Workspace not found: ${task.workspaceId}`);
      }

      try {
        if (args.filePath) {
          const diff = await env.git.getFileDiff(args.filePath);
          return ok({
            taskId: task.id,
            filePath: args.filePath,
            diff: renderUnifiedDiff(diff),
          });
        }

        const status = await env.git.getFullStatus();
        return ok({
          taskId: task.id,
          branch: status.currentBranch,
          totalAdded: status.totalAdded,
          totalDeleted: status.totalDeleted,
          staged: status.staged,
          unstaged: status.unstaged,
        });
      } catch (error) {
        return fail('git_error', 'Reading the diff failed.', String(error));
      }
    }
  );
}
