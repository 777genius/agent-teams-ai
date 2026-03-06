import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/task-list.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('task_list', () => {
  function setup(response = ok('[{"id":"1"},{"id":"2"}]')) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('task_list')! };
  }

  it('builds correct CLI args', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme' });
    expect(runner.execute).toHaveBeenCalledWith(['--team', 'acme', 'task', 'list']);
  });

  it('returns parsed JSON array', async () => {
    const { tool } = setup();
    const result = await tool.execute({ team: 'acme' });
    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('team dir not found'));
    await expect(tool.execute({ team: 'bad' })).rejects.toThrow('Failed to list tasks');
  });
});
