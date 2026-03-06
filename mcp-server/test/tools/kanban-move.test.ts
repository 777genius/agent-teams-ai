import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/kanban-move.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('kanban_move', () => {
  function setup(response = ok('OK kanban #1 column=review\n')) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('kanban_move')! };
  }

  it('builds set-column CLI args', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', task_id: '1', operation: 'set-column', column: 'review' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'kanban', 'set-column', '1', 'review',
    ]);
  });

  it('builds clear CLI args', async () => {
    const { runner, tool } = setup(ok('OK kanban #1 cleared\n'));
    await tool.execute({ team: 'acme', task_id: '1', operation: 'clear' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'kanban', 'clear', '1',
    ]);
  });

  it('throws UserError when set-column called without column', async () => {
    const { tool } = setup();
    await expect(
      tool.execute({ team: 'acme', task_id: '1', operation: 'set-column' }),
    ).rejects.toThrow('column is required');
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('task not found'));
    await expect(
      tool.execute({ team: 'acme', task_id: '99', operation: 'clear' }),
    ).rejects.toThrow('Failed to update kanban');
  });
});
