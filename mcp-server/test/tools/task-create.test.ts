import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/task-create.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('task_create', () => {
  function setup(response = ok('{"id":"1","subject":"Fix bug","status":"in_progress"}')) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('task_create')! };
  }

  it('builds minimal CLI args', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', subject: 'Fix bug' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'task', 'create', '--subject', 'Fix bug',
    ]);
  });

  it('includes all optional flags', async () => {
    const { runner, tool } = setup();
    await tool.execute({
      team: 'acme',
      subject: 'Big task',
      description: 'Details here',
      owner: 'alice',
      blocked_by: ['1', '2'],
      related: ['3'],
      status: 'pending',
      active_form: 'Fixing bug',
      notify: true,
      from: 'bob',
    });
    const args = runner.execute.mock.calls[0]![0] as string[];
    expect(args).toContain('--description');
    expect(args).toContain('--owner');
    expect(args).toContain('--blocked-by');
    expect(args[args.indexOf('--blocked-by') + 1]).toBe('1,2');
    expect(args).toContain('--related');
    expect(args[args.indexOf('--related') + 1]).toBe('3');
    expect(args).toContain('--status');
    expect(args).toContain('--activeForm');
    expect(args).toContain('--notify');
    expect(args).toContain('--from');
  });

  it('skips empty blocked_by array', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', subject: 'Task', blocked_by: [] });
    const args = runner.execute.mock.calls[0]![0] as string[];
    expect(args).not.toContain('--blocked-by');
  });

  it('returns parsed JSON', async () => {
    const { tool } = setup();
    const result = await tool.execute({ team: 'acme', subject: 'Fix bug' });
    expect(result).toEqual({ id: '1', subject: 'Fix bug', status: 'in_progress' });
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('team not found'));
    await expect(tool.execute({ team: 'bad', subject: 'X' })).rejects.toThrow('Failed to create task');
  });
});
