import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/task-link.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('task_link', () => {
  function setup(response = ok('OK task #1 blocked-by #2\n')) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('task_link')! };
  }

  it('builds link CLI args', async () => {
    const { runner, tool } = setup();
    await tool.execute({
      team: 'acme', task_id: '1', operation: 'link',
      relationship: 'blocked-by', target_id: '2',
    });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'task', 'link', '1', '--blocked-by', '2',
    ]);
  });

  it('builds unlink CLI args', async () => {
    const { runner, tool } = setup(ok('OK task #1 unlinked from #2\n'));
    await tool.execute({
      team: 'acme', task_id: '1', operation: 'unlink',
      relationship: 'related', target_id: '3',
    });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'task', 'unlink', '1', '--related', '3',
    ]);
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('circular dependency'));
    await expect(
      tool.execute({
        team: 'acme', task_id: '1', operation: 'link',
        relationship: 'blocked-by', target_id: '1',
      }),
    ).rejects.toThrow('Failed to link tasks');
  });
});
