import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/task-briefing.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('task_briefing', () => {
  const briefingText = '=== Task Briefing for alice ===\nTask #1: Fix bug [in_progress]\n';

  function setup(response = ok(briefingText)) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('task_briefing')! };
  }

  it('builds correct CLI args', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', member: 'alice' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'task', 'briefing', '--for', 'alice',
    ]);
  });

  it('returns trimmed plain text', async () => {
    const { tool } = setup();
    const result = await tool.execute({ team: 'acme', member: 'alice' });
    expect(result).toBe('=== Task Briefing for alice ===\nTask #1: Fix bug [in_progress]');
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('member not found'));
    await expect(tool.execute({ team: 'acme', member: 'nobody' })).rejects.toThrow('Failed to get briefing');
  });
});
