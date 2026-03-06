import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/task-get.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('task_get', () => {
  function setup(response = ok('{"id":"42","subject":"Test","status":"pending"}')) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('task_get')! };
  }

  it('builds correct CLI args', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', task_id: '42' });
    expect(runner.execute).toHaveBeenCalledWith(['--team', 'acme', 'task', 'get', '42']);
  });

  it('returns parsed JSON', async () => {
    const { tool } = setup();
    const result = await tool.execute({ team: 'acme', task_id: '42' });
    expect(result).toEqual({ id: '42', subject: 'Test', status: 'pending' });
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('Task not found: #99'));
    await expect(tool.execute({ team: 'acme', task_id: '99' })).rejects.toThrow('Failed to get task');
  });
});
