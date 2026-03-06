import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/task-set-owner.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('task_set_owner', () => {
  function setup(response = ok('OK task #1 owner=alice\n')) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('task_set_owner')! };
  }

  it('builds args for assignment', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', task_id: '1', owner: 'alice' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'task', 'set-owner', '1', 'alice',
    ]);
  });

  it('builds args for clear', async () => {
    const { runner, tool } = setup(ok('OK task #1 owner=cleared\n'));
    await tool.execute({ team: 'acme', task_id: '1', owner: 'clear' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'task', 'set-owner', '1', 'clear',
    ]);
  });

  it('includes notify and from flags', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', task_id: '1', owner: 'alice', notify: true, from: 'bob' });
    const args = runner.execute.mock.calls[0]![0] as string[];
    expect(args).toContain('--notify');
    expect(args).toContain('--from');
    expect(args[args.indexOf('--from') + 1]).toBe('bob');
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('member not found'));
    await expect(tool.execute({ team: 'acme', task_id: '1', owner: 'nobody' })).rejects.toThrow('Failed to set owner');
  });
});
