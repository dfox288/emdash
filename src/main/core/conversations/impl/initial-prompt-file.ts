import { chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import type { AgentProviderId } from '@shared/core/agents/agent-provider-registry';

const PROMPT_FILE_THRESHOLD = 8_000;

function safePromptFileName(conversationId: string): string {
  const safeId = conversationId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'conversation';
  return `emdash-initial-prompt-${safeId}.md`;
}

function promptFileReference(filePath: string): string {
  return `The full initial context is stored in this file: ${filePath}\n\nPlease read it before starting the task.`;
}

export function shouldUseInitialPromptFile(prompt: string | undefined): boolean {
  return Boolean(prompt && prompt.length > PROMPT_FILE_THRESHOLD);
}

export async function writeLocalInitialPromptFile(args: {
  conversationId: string;
  prompt: string;
}): Promise<string> {
  const filePath = join(tmpdir(), safePromptFileName(args.conversationId));
  await writeFile(filePath, args.prompt, { encoding: 'utf-8', mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

export async function writeRemoteInitialPromptFile(args: {
  conversationId: string;
  prompt: string;
  fs: SshFileSystem;
  remoteHome: string;
}): Promise<string> {
  const remoteHome = args.remoteHome.trim().replace(/\/+$/, '');
  if (!remoteHome.startsWith('/')) {
    throw new Error('Remote HOME is unavailable for initial prompt file delivery');
  }

  const dirPath = `${remoteHome}/.cache/emdash/initial-prompts`;
  await args.fs.mkdir(dirPath, { recursive: true });
  await args.fs.chmod(dirPath, 0o700);
  const filePath = `${dirPath}/${safePromptFileName(args.conversationId)}`;
  await args.fs.write(filePath, args.prompt);
  await args.fs.chmod(filePath, 0o600);
  return filePath;
}

export function buildKilocodeFilePromptArgs(filePath: string): string[] {
  return ['run', '--file', filePath, 'Analyze this issue'];
}

export function buildInitialPromptFileDelivery(args: {
  providerId: AgentProviderId;
  filePath: string;
}): { extraInitialArgs?: string[]; prompt?: string } {
  if (args.providerId === 'kilocode') {
    return { extraInitialArgs: buildKilocodeFilePromptArgs(args.filePath) };
  }

  return { prompt: promptFileReference(args.filePath) };
}
