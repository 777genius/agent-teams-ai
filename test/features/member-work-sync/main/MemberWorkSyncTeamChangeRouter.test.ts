import { MemberWorkSyncTeamChangeRouter } from '@features/member-work-sync/main/adapters/input/MemberWorkSyncTeamChangeRouter';
import { describe, expect, it, vi } from 'vitest';

function createRouter(activeMembers: string[] = ['alice', 'bob']) {
  const queue = {
    enqueue: vi.fn(),
    dropTeam: vi.fn(),
  };
  const router = new MemberWorkSyncTeamChangeRouter(
    {
      loadActiveMemberNames: async () => activeMembers,
    },
    queue as never
  );
  return { queue, router };
}

describe('MemberWorkSyncTeamChangeRouter', () => {
  it('routes task and config events to all active members', async () => {
    const { queue, router } = createRouter();

    router.noteTeamChange({ type: 'task', teamName: 'team-a', detail: 'task-1.json' });
    await Promise.resolve();

    expect(queue.enqueue).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'alice',
      triggerReason: 'task_changed',
      runAfterMs: undefined,
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
      triggerReason: 'task_changed',
      runAfterMs: undefined,
    });
  });

  it('routes task events to resolver-impacted members when task identity is available', async () => {
    const queue = {
      enqueue: vi.fn(),
      dropTeam: vi.fn(),
    };
    const resolver = {
      resolve: vi.fn(async () => ({
        memberNames: ['bob'],
        fallbackTeamWide: false,
        diagnostics: [],
      })),
    };
    const router = new MemberWorkSyncTeamChangeRouter(
      { loadActiveMemberNames: async () => ['alice', 'bob'] },
      queue as never,
      undefined,
      resolver as never
    );

    router.noteTeamChange({
      type: 'task',
      teamName: 'team-a',
      detail: 'task-1.json',
      taskId: 'task-1',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolver.resolve).toHaveBeenCalledWith({ teamName: 'team-a', taskId: 'task-1' });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
      triggerReason: 'task_changed',
    });
  });

  it('routes inbox and tool-finish events to the addressed member only', () => {
    const { queue, router } = createRouter();

    router.noteTeamChange({ type: 'inbox', teamName: 'team-a', detail: 'inboxes/bob.json' });
    router.noteTeamChange({
      type: 'tool-activity',
      teamName: 'team-a',
      detail: JSON.stringify({ action: 'finish', memberName: 'alice', toolUseId: 'tool-1' }),
    });

    expect(queue.enqueue).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
      triggerReason: 'inbox_changed',
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'alice',
      triggerReason: 'tool_finished',
    });
  });

  it('refreshes member runtime state when the team goes offline', async () => {
    const { queue, router } = createRouter();

    router.noteTeamChange({ type: 'lead-activity', teamName: 'team-a', detail: 'offline' });
    await Promise.resolve();

    expect(queue.dropTeam).toHaveBeenCalledWith('team-a');
    expect(queue.enqueue).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'alice',
      triggerReason: 'runtime_activity',
      runAfterMs: 0,
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'bob',
      triggerReason: 'runtime_activity',
      runAfterMs: 0,
    });
  });

  it('routes member-turn-settled events to one member reconcile', () => {
    const { queue, router } = createRouter();

    router.noteTeamChange({
      type: 'member-turn-settled',
      teamName: 'team-a',
      detail: JSON.stringify({ memberName: 'alice', sourceId: 'source-1', provider: 'claude' }),
    });

    expect(queue.enqueue).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'alice',
      triggerReason: 'turn_settled',
    });
  });

  it.each([
    {
      name: 'inbox',
      event: { type: 'inbox' as const, teamName: 'team-a', detail: 'inboxes/bob.json' },
      memberName: 'bob',
      triggerReason: 'inbox_changed',
    },
    {
      name: 'tool finish',
      event: {
        type: 'tool-activity' as const,
        teamName: 'team-a',
        detail: JSON.stringify({
          action: 'finish',
          memberName: 'alice',
          toolUseId: 'tool-1',
        }),
      },
      memberName: 'alice',
      triggerReason: 'tool_finished',
    },
    {
      name: 'member spawn',
      event: { type: 'member-spawn' as const, teamName: 'team-a', detail: 'bob' },
      memberName: 'bob',
      triggerReason: 'member_spawned',
      runAfterMs: 30_000,
    },
    {
      name: 'member turn settled',
      event: {
        type: 'member-turn-settled' as const,
        teamName: 'team-a',
        detail: JSON.stringify({ memberName: 'alice', sourceId: 'source-1', provider: 'opencode' }),
      },
      memberName: 'alice',
      triggerReason: 'turn_settled',
    },
  ])('keeps targeted router event $name scoped to one member', (scenario) => {
    const { queue, router } = createRouter(['alice', 'bob', 'carol']);

    router.noteTeamChange(scenario.event);

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: scenario.memberName,
      triggerReason: scenario.triggerReason,
      ...(scenario.runAfterMs === undefined ? {} : { runAfterMs: scenario.runAfterMs }),
    });
  });

  it('ignores malformed member-turn-settled details', () => {
    const { queue, router } = createRouter();

    router.noteTeamChange({
      type: 'member-turn-settled',
      teamName: 'team-a',
      detail: 'not-json',
    });

    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
