import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/review-action.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('review_action', () => {
  function setup(response = ok('OK review #1 approved\n')) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('review_action')! };
  }

  it('builds approve CLI args (no comment)', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', task_id: '1', decision: 'approve' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'review', 'approve', '1',
    ]);
  });

  it('builds approve CLI args with --note (not --comment)', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', task_id: '1', decision: 'approve', comment: 'LGTM' });
    const args = runner.execute.mock.calls[0]![0] as string[];
    // approve uses --note, NOT --comment
    expect(args).toContain('--note');
    expect(args[args.indexOf('--note') + 1]).toBe('LGTM');
    expect(args).not.toContain('--comment');
  });

  it('builds request-changes CLI args with --comment (not --note)', async () => {
    const { runner, tool } = setup(ok('OK review #1 requested changes\n'));
    await tool.execute({
      team: 'acme', task_id: '1', decision: 'request-changes', comment: 'Fix tests',
    });
    const args = runner.execute.mock.calls[0]![0] as string[];
    expect(args).toContain('--comment');
    expect(args[args.indexOf('--comment') + 1]).toBe('Fix tests');
    expect(args).not.toContain('--note');
  });

  it('throws when request-changes has no comment', async () => {
    const { tool } = setup();
    await expect(
      tool.execute({ team: 'acme', task_id: '1', decision: 'request-changes' }),
    ).rejects.toThrow('comment is required when requesting changes');
  });

  it('includes from and notify_owner flags', async () => {
    const { runner, tool } = setup();
    await tool.execute({
      team: 'acme', task_id: '1', decision: 'approve',
      from: 'alice', notify_owner: true,
    });
    const args = runner.execute.mock.calls[0]![0] as string[];
    expect(args).toContain('--from');
    expect(args).toContain('--notify-owner');
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('task not in review'));
    await expect(
      tool.execute({ team: 'acme', task_id: '1', decision: 'approve' }),
    ).rejects.toThrow('Failed to approve');
  });
});
