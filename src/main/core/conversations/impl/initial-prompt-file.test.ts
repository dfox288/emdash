import { describe, expect, it } from 'vitest';
import { buildInitialPromptFileDelivery, shouldUseInitialPromptFile } from './initial-prompt-file';

describe('initial prompt file delivery', () => {
  it('uses files only for long generic prompts', () => {
    expect(shouldUseInitialPromptFile('short')).toBe(false);
    expect(shouldUseInitialPromptFile('x'.repeat(8_001))).toBe(true);
  });

  it('uses Kilocode run --file args instead of positional prompt args', () => {
    expect(
      buildInitialPromptFileDelivery({ providerId: 'kilocode', filePath: '/tmp/context.md' })
    ).toEqual({ extraInitialArgs: ['run', '--file', '/tmp/context.md', 'Analyze this issue'] });
  });

  it('uses a short file reference prompt for other providers', () => {
    expect(
      buildInitialPromptFileDelivery({ providerId: 'claude', filePath: '/tmp/context.md' })
    ).toEqual({
      prompt:
        'The full initial context is stored in this file: /tmp/context.md\n\nPlease read it before starting the task.',
    });
  });
});
