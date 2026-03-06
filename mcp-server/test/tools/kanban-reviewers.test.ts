import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/kanban-reviewers.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('kanban_reviewers', () => {
  function setup(response = ok('["alice","bob"]')) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('kanban_reviewers')! };
  }

  it('builds list CLI args', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', operation: 'list' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'kanban', 'reviewers', 'list',
    ]);
  });

  it('returns JSON array for list', async () => {
    const { tool } = setup();
    const result = await tool.execute({ team: 'acme', operation: 'list' });
    expect(result).toEqual(['alice', 'bob']);
  });

  it('builds add CLI args with name', async () => {
    const { runner, tool } = setup(ok('OK reviewer added\n'));
    await tool.execute({ team: 'acme', operation: 'add', name: 'charlie' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'kanban', 'reviewers', 'add', 'charlie',
    ]);
  });

  it('returns OK text for add/remove', async () => {
    const { tool } = setup(ok('OK reviewer added\n'));
    const result = await tool.execute({ team: 'acme', operation: 'add', name: 'charlie' });
    expect(result).toBe('reviewer added');
  });

  it('throws UserError when add called without name', async () => {
    const { tool } = setup();
    await expect(
      tool.execute({ team: 'acme', operation: 'add' }),
    ).rejects.toThrow('name is required');
  });

  it('throws UserError when remove called without name', async () => {
    const { tool } = setup();
    await expect(
      tool.execute({ team: 'acme', operation: 'remove' }),
    ).rejects.toThrow('name is required');
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('reviewer not found'));
    await expect(
      tool.execute({ team: 'acme', operation: 'remove', name: 'nobody' }),
    ).rejects.toThrow('Failed to manage reviewers');
  });
});
