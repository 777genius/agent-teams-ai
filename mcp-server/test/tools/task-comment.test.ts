import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/task-comment.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('task_comment', () => {
  function setup(response = ok('OK comment added to task #1\n')) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('task_comment')! };
  }

  it('builds correct CLI args', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', task_id: '1', text: 'Looking good!' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'task', 'comment', '1', '--text', 'Looking good!',
    ]);
  });

  it('includes from flag', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', task_id: '1', text: 'Done', from: 'alice' });
    const args = runner.execute.mock.calls[0]![0] as string[];
    expect(args).toContain('--from');
    expect(args[args.indexOf('--from') + 1]).toBe('alice');
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('task not found'));
    await expect(tool.execute({ team: 'acme', task_id: '99', text: 'Hi' })).rejects.toThrow('Failed to add comment');
  });
});
