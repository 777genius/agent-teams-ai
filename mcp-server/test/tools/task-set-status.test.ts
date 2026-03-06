import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/task-set-status.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('task_set_status', () => {
  function setup(response = ok('OK task #1 status=completed\n')) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('task_set_status')! };
  }

  it('builds correct CLI args', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', task_id: '1', status: 'completed' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'task', 'set-status', '1', 'completed',
    ]);
  });

  it('returns parsed OK text', async () => {
    const { tool } = setup();
    const result = await tool.execute({ team: 'acme', task_id: '1', status: 'completed' });
    expect(result).toBe('task #1 status=completed');
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('invalid transition'));
    await expect(tool.execute({ team: 'acme', task_id: '1', status: 'deleted' })).rejects.toThrow('Failed to set status');
  });
});
