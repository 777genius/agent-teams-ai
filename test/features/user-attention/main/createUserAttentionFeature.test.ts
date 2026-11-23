import { describe, expect, it, vi } from 'vitest';

import { createUserAttentionFeature } from '../../../../src/features/user-attention/main/composition/createUserAttentionFeature';

describe('User Attention read facade', () => {
  it('selects old awaiting tasks without the global 500-task list', async () => {
    const listTeams = vi.fn(async () => [
      { teamName: 'a', displayName: 'Alpha' },
      { teamName: 'deleted', displayName: 'Deleted', deletedAt: '2026-11-23' },
    ]);
    const getUserAttentionTasks = vi.fn(async () => [
      { id: 'old', subject: 'Old awaiting task', status: 'pending', needsClarification: 'user' },
    ]);
    const getMessageFeed = vi.fn(async () => ({ teamName: 'a', feedRevision: '1', messages: [] }));
    const facade = createUserAttentionFeature({
      getContextId: () => 'root-1',
      getTeamDataService: () => ({ listTeams, getUserAttentionTasks, getMessageFeed } as never),
    });
    const result = await facade.getUserAttentionSnapshot();
    expect(result.contextId).toBe('root-1');
    expect(result.complete).toBe(true);
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0].tasks[0].taskId).toBe('old');
    expect(getUserAttentionTasks).toHaveBeenCalledWith('a');
    expect(getUserAttentionTasks).not.toHaveBeenCalledWith('deleted');
  });

  it('supports one-team refresh and returns degraded state on partial failures', async () => {
    const facade = createUserAttentionFeature({
      getContextId: () => 'root-1',
      getTeamDataService: () => ({
        listTeams: async () => [
          { teamName: 'ok', displayName: 'Ok' },
          { teamName: 'broken', displayName: 'Broken' },
        ],
        getUserAttentionTasks: async (team: string) => {
          if (team === 'broken') throw new Error('private path');
          return [];
        },
        getMessageFeed: async (team: string) => ({ teamName: team, feedRevision: 'x', messages: [] }),
      } as never),
    });
    const all = await facade.getUserAttentionSnapshot();
    expect(all.complete).toBe(false);
    expect(all.teams[1].error).toBeTruthy();
    expect(JSON.stringify(all)).not.toContain('private path');
    const filtered = await facade.getUserAttentionSnapshot('ok');
    expect(filtered.complete).toBe(true);
    expect(filtered.teams.map((t) => t.teamName)).toEqual(['ok']);
  });

  it('does not drop awaiting tasks when the message feed fails', async () => {
    const facade = createUserAttentionFeature({
      getContextId: () => 'root-1',
      getTeamDataService: () => ({
        listTeams: async () => [{ teamName: 'alpha', displayName: 'Alpha' }],
        getUserAttentionTasks: async () => [
          { id: 'task-1', subject: 'Decision needed', needsClarification: 'user', status: 'pending' },
        ],
        getMessageFeed: async () => { throw new Error('Simulated unread source failure'); },
      } as never),
    });
    const snapshot = await facade.getUserAttentionSnapshot();
    expect(snapshot.complete).toBe(false);
    expect(snapshot.teams[0].tasks.map((task) => task.taskId)).toEqual(['task-1']);
    expect(snapshot.teams[0].messages).toHaveLength(0);
    expect(snapshot.teams[0].error).toBeTruthy();
  });

  it('fences a root switch during in-flight reads', async () => {
    let context = 'root-1';
    let resolve!: (value: { teamName: string; feedRevision: string; messages: [] }) => void;
    const pending = new Promise<{ teamName: string; feedRevision: string; messages: [] }>((done) => {
      resolve = done;
    });
    const facade = createUserAttentionFeature({
      getContextId: () => context,
      getTeamDataService: () => ({
        listTeams: async () => [{ teamName: 'x', displayName: 'X' }],
        getUserAttentionTasks: async () => [],
        getMessageFeed: () => pending,
      } as never),
    });
    const request = facade.getUserAttentionSnapshot();
    await Promise.resolve();
    context = 'root-2';
    resolve({ teamName: 'x', feedRevision: '1', messages: [] });
    await expect(request).rejects.toThrow('context changed');
  });
});
