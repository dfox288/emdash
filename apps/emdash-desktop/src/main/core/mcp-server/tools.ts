/**
 * POC tool surface for the inbound MCP server — the "manager loop":
 *
 *   emdash_list_projects → getProjects            (projects/operations/getProjects.ts)
 *   emdash_create_lane   → taskService.createTask → taskService.launch →
 *                          createConversation      (the proven automations sequence,
 *                          see automations/actions/taskCreate.ts)
 *   emdash_lane_status   → getTasks + getConversationsForTask (agentStatus)
 *   emdash_lane_diff     → workspace gitWorktree (getChangedFiles / getFileAtRef vs base)
 *   emdash_lane_output   → ptySessionRegistry.peek (read-only ring buffer)
 *   emdash_lane_send     → pty.write via buildPromptInjectionPayload (follow-up prompt)
 *   emdash_lane_archive  → taskService.archiveTask (archives + tears down worktree)
 *
 * No business logic lives here — every tool validates args and calls existing
 * operations. Runtime deps are imported lazily inside the handlers so that
 * constructing an `McpServer` (e.g. in tests) does not pull in Electron or
 * the database client.
 */
import { randomUUID } from 'node:crypto';
import type { GitBranchRef } from '@emdash/core/git';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getProvider } from '@shared/core/agents/agent-provider-registry';
import type { Conversation } from '@shared/core/conversations/conversations';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import { buildWorkspaceConfigFromPreset } from '@shared/core/workspaces/build-workspace-config-from-preset';
import { buildPromptInjectionPayload } from '@shared/prompt-injection';

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

function resolveDefaultBranch(
  branches: GitBranchRef[],
  defaultName: string
): GitBranchRef | undefined {
  return (
    branches.find((b) => b.type === 'local' && b.branch === defaultName) ??
    branches.find((b) => b.branch === defaultName)
  );
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

/**
 * Resolves the conversation a lane tool should target: an explicit
 * conversationId when given, otherwise the lane's initial conversation,
 * falling back to the first one.
 */
async function resolveLaneConversation(
  taskId: string,
  conversationId?: string
): Promise<
  | {
      ok: true;
      task: NonNullable<Awaited<ReturnType<typeof findTask>>>;
      conversation: Conversation;
    }
  | { ok: false; reply: ToolReply }
> {
  const task = await findTask(taskId);
  if (!task) return { ok: false, reply: fail('task_not_found', `Task not found: ${taskId}`) };

  const { getConversationsForTask } =
    await import('@main/core/conversations/getConversationsForTask');
  const conversations = await getConversationsForTask(task.projectId, task.id);
  const conversation = conversationId
    ? conversations.find((c) => c.id === conversationId)
    : (conversations.find((c) => c.isInitialConversation) ?? conversations[0]);
  if (!conversation) {
    return {
      ok: false,
      reply: fail(
        'conversation_not_found',
        conversationId
          ? `Conversation not found on this lane: ${conversationId}`
          : `Lane has no conversations: ${taskId}`
      ),
    };
  }
  return { ok: true, task, conversation };
}

// Covers CSI sequences, OSC sequences (BEL- or ST-terminated), and bare
// single-character escapes — enough to make TUI output readable for an LLM.
const ANSI_PATTERN = new RegExp(
  ['\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', '\\x1b\\[[0-9;?]*[ -/]*[@-~]', '\\x1b[@-_]'].join(
    '|'
  ),
  'g'
);

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
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

      const snapshot = await project.gitRepository.getSnapshot();
      const defaultBranchName = await project.gitRepository.getDefaultBranch();
      const defaultBranch = resolveDefaultBranch(snapshot.refs.value.branches, defaultBranchName);
      if (!defaultBranch) {
        return fail(
          'default_branch_not_found',
          'Could not resolve a default branch to fork from — does the repository have an initial commit?'
        );
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
        'Get lane state: task lifecycle status, derived agent activity ' +
        '(working | needs_input | error | completed | idle | none), recent commits on the ' +
        'lane branch, and PRs whose head is the lane branch. A change-lane is done when ' +
        'activity is completed AND an open PR exists.',
      inputSchema: laneStatusInput,
    },
    async (args): Promise<ToolReply> => {
      const task = await findTask(args.taskId);
      if (!task) return fail('task_not_found', `Task not found: ${args.taskId}`);

      const { getConversationsForTask } =
        await import('@main/core/conversations/getConversationsForTask');
      const conversations = await getConversationsForTask(task.projectId, task.id);

      // Recent commits on the lane branch — the manager's "did the agent
      // commit its work" check. Best-effort: null when the workspace is
      // not mounted (e.g. after archive or before provisioning).
      let commits: { hash: string; subject: string; isPushed: boolean }[] | null = null;
      if (task.workspaceId) {
        try {
          const { resolveWorkspace } = await import('@main/core/projects/utils');
          const env = resolveWorkspace(task.projectId, task.workspaceId);
          if (env) {
            const log = await env.gitWorktree.getLog({ maxCount: 10 });
            commits = log.commits.map((c) => ({
              hash: c.hash.slice(0, 8),
              subject: c.subject,
              isPushed: c.isPushed,
            }));
          }
        } catch {
          commits = null;
        }
      }

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
        // PRs whose head matches the lane branch, synced by emdash's PR engine.
        prs: task.prs.map((pr) => ({
          identifier: pr.identifier,
          title: pr.title,
          status: pr.status,
          url: pr.url,
          isDraft: pr.isDraft,
          reviewDecision: pr.reviewDecision,
        })),
        commits,
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
        'When set, return before/after content for this file (relative to the worktree root). ' +
          'Omit to get the changed-file summary for the whole lane.'
      ),
  };
  server.registerTool(
    'emdash_lane_diff',
    {
      title: 'Lane diff',
      description:
        'Read the changes an agent committed in a lane (the lane branch vs the base branch it ' +
        'was forked from — i.e. what its PR contains). Without filePath: per-file change summary ' +
        '(status, additions, deletions). With filePath: the file content before (base) and after ' +
        '(lane HEAD).',
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
        // The lane's committed work = changes between its branch HEAD and the
        // base branch it was forked from (i.e. what its PR contains).
        const { projectManager } = await import('@main/core/projects/project-manager');
        const project = projectManager.getProject(task.projectId);
        const head = await env.gitWorktree.getHead();
        const headOid = head.kind === 'unborn' ? null : head.oid;
        const baseBranch = project ? await project.gitRepository.getDefaultBranch() : null;
        if (!headOid || !baseBranch) {
          return fail(
            'diff_unavailable',
            'The lane has no commits yet, or its base branch could not be resolved.'
          );
        }

        if (args.filePath) {
          // Before/after file content (base branch vs lane HEAD). Null means the
          // file did not exist at that ref (added or deleted).
          const before = await env.gitWorktree.getFileAtRef(args.filePath, baseBranch);
          const after = await env.gitWorktree.getFileAtRef(args.filePath, headOid);
          return ok({ taskId: task.id, filePath: args.filePath, base: baseBranch, before, after });
        }

        const changes = await env.gitWorktree.getChangedFiles({
          base: { kind: 'branch', branch: { type: 'local', branch: baseBranch } },
          head: { kind: 'commit', sha: headOid },
        });
        return ok({
          taskId: task.id,
          base: baseBranch,
          head: head.kind === 'branch' ? head.name : headOid.slice(0, 8),
          changes: changes.map((c) => ({
            path: c.path,
            status: c.status,
            additions: c.additions,
            deletions: c.deletions,
          })),
        });
      } catch (error) {
        return fail('git_error', 'Reading the diff failed.', String(error));
      }
    }
  );

  // emdash_lane_output ──────────────────────────────────────────────────────
  const laneOutputInput = {
    taskId: z.string().describe('Task id returned by emdash_create_lane.'),
    conversationId: z
      .string()
      .optional()
      .describe('Target conversation; defaults to the lane\u2019s initial conversation.'),
    tail: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Return only the last N characters (after ANSI stripping). Default 10000.'),
    raw: z
      .boolean()
      .optional()
      .describe('Return raw terminal bytes including ANSI escape sequences. Default false.'),
  };
  server.registerTool(
    'emdash_lane_output',
    {
      title: 'Lane output',
      description:
        'Read the recent terminal output of a lane\u2019s agent session (bounded 64 KB ring ' +
        'buffer, read-only). ANSI escape sequences are stripped unless raw is set.',
      inputSchema: laneOutputInput,
    },
    async (args): Promise<ToolReply> => {
      const resolved = await resolveLaneConversation(args.taskId, args.conversationId);
      if (!resolved.ok) return resolved.reply;
      const { task, conversation } = resolved;

      const { ptySessionRegistry } = await import('@main/core/pty/pty-session-registry');
      const sessionId = makePtySessionId(task.projectId, task.id, conversation.id);
      const buffer = ptySessionRegistry.peek(sessionId);
      const running = ptySessionRegistry.get(sessionId) !== undefined;
      if (buffer === undefined) {
        return fail(
          'no_session_output',
          'No terminal buffer for this conversation \u2014 the agent session is not running ' +
            '(sessions do not survive app restarts).',
          { conversationId: conversation.id, running }
        );
      }

      const text = args.raw ? buffer : stripAnsi(buffer);
      const tail = args.tail ?? 10_000;
      return ok({
        taskId: args.taskId,
        conversationId: conversation.id,
        running,
        truncated: text.length > tail,
        output: text.slice(-tail),
      });
    }
  );

  // emdash_lane_send ────────────────────────────────────────────────────────
  const laneSendInput = {
    taskId: z.string().describe('Task id returned by emdash_create_lane.'),
    prompt: z.string().min(1).describe('Follow-up prompt to submit to the running agent.'),
    conversationId: z
      .string()
      .optional()
      .describe('Target conversation; defaults to the lane\u2019s initial conversation.'),
  };
  server.registerTool(
    'emdash_lane_send',
    {
      title: 'Send follow-up to lane',
      description:
        'Submit a follow-up prompt to the running agent of a lane (e.g. review feedback on the ' +
        'same issue). Fails when the agent session is not running. For new issues create a new ' +
        'lane instead of reusing one.',
      inputSchema: laneSendInput,
    },
    async (args): Promise<ToolReply> => {
      const resolved = await resolveLaneConversation(args.taskId, args.conversationId);
      if (!resolved.ok) return resolved.reply;
      const { task, conversation } = resolved;

      const { ptySessionRegistry } = await import('@main/core/pty/pty-session-registry');
      const sessionId = makePtySessionId(task.projectId, task.id, conversation.id);
      const pty = ptySessionRegistry.get(sessionId);
      if (!pty) {
        return fail(
          'lane_not_running',
          'The agent session is not running (sessions do not survive app restarts).',
          { conversationId: conversation.id }
        );
      }

      // Same payload mechanics the initial-prompt delivery uses (see
      // conversations/impl/initial-prompt-delivery.ts), but ALWAYS with a
      // pause before the submit sequence: TUIs swallow a same-write Enter
      // while still processing the pasted text (verified with claude).
      const payload = buildPromptInjectionPayload({
        providerId: conversation.providerId,
        text: args.prompt,
      });
      const provider = getProvider(conversation.providerId);
      const submitSequence = provider?.keystrokeSubmitSequence ?? '\r';
      const submitDelayMs = provider?.keystrokeSubmitDelayMs ?? 150;
      pty.write(payload);
      await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
      pty.write(submitSequence);

      return ok({
        taskId: args.taskId,
        conversationId: conversation.id,
        sent: true,
        chars: args.prompt.length,
      });
    }
  );

  // emdash_lane_archive ─────────────────────────────────────────────────────
  const laneArchiveInput = {
    taskId: z.string().describe('Task id returned by emdash_create_lane.'),
  };
  server.registerTool(
    'emdash_lane_archive',
    {
      title: 'Archive lane',
      description:
        'Archive a finished lane: ends the agent session and removes the worktree when no other ' +
        'task uses it (the branch survives). Reversible from the emdash UI. Call this only after ' +
        'the result has been consumed (e.g. PR opened or merged).',
      inputSchema: laneArchiveInput,
    },
    async (args): Promise<ToolReply> => {
      const task = await findTask(args.taskId);
      if (!task) return fail('task_not_found', `Task not found: ${args.taskId}`);
      if (task.archivedAt) {
        return ok({ taskId: task.id, archived: true, alreadyArchived: true });
      }

      const { taskService } = await import('@main/core/tasks/task-service');
      await taskService.archiveTask(task.projectId, task.id);
      return ok({ taskId: task.id, archived: true });
    }
  );
}
