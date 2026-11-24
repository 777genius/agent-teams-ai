import { describe, expect, it, vi } from 'vitest';

import { buildAttentionModel } from '../../../../src/features/user-attention/core/domain/buildAttention';
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

  it('includes verified project histories under their logical team', async () => {
    const source = {
      listTeams: async () => [{
        teamName: 'logical', displayName: 'Logical team',
        projectHistoryContexts: [{ executionTeamName: 'native-1', projectPath: '/projects/one' }],
      }],
      getUserAttentionTasks: async (teamName: string) => teamName === 'native-1'
        ? [{ id: '2', subject: 'Review project decision', status: 'pending', needsClarification: 'user' }]
        : [],
      getMessageFeed: async (teamName: string) => ({ teamName, feedRevision: '1', messages: [] }),
    };
    const facade = createUserAttentionFeature({
      getContextId: () => 'local',
      getTeamDataService: () => source as never,
    });
    const snapshot = await facade.getUserAttentionSnapshot();
    expect(snapshot.complete).toBe(true);
    const child = snapshot.teams.find((team) => team.teamName === 'native-1');
    expect(child?.logicalTeamName).toBe('logical');
    expect(child?.projectPath).toBe('/projects/one');
    expect(child?.tasks[0].logicalTeamName).toBe('logical');
    const targeted = await facade.getUserAttentionSnapshot('native-1');
    expect(targeted.teams.map((team) => team.teamName)).toEqual(['native-1']);
  });

  it('uses canonical active member summaries and routes removed senders to team-feed', async () => {
    const facade = createUserAttentionFeature({
      getContextId: () => 'local',
      getTeamDataService: () => ({
        listTeams: async () => [{ teamName: 'alpha', displayName: 'Alpha',
          members: [{ name: 'alice' }], leadName: 'team-lead' }],
        getUserAttentionTasks: async () => [],
        getMessageFeed: async () => ({ teamName: 'alpha', feedRevision: '1', messages: [
          { messageId: 'active', from: 'alice', to: 'user', text: 'Active member',
            timestamp: '2026-11-23T12:00:00Z', read: false },
          { messageId: 'removed', from: 'former', to: 'user', text: 'Historical member',
            timestamp: '2026-11-23T12:01:00Z', read: false },
        ] }),
      } as never),
    });
    const snapshot = await facade.getUserAttentionSnapshot();
    expect(snapshot.teams[0].directParticipants).toEqual(['alice']);
    expect(snapshot.teams[0].leadName).toBe('team-lead');
    const model = buildAttentionModel(snapshot, () => ({
      direct: new Set(), group: new Set(),
    }), (message) => message.messageId ?? '');
    expect(model.chats.map((chat) => chat.scope)).toEqual([
      { kind: 'team-feed' }, { kind: 'direct', participant: 'alice' },
    ]);
    expect(model.unreadMessageCount).toBe(2);
  });

  it('shares Messenger relay identity before projection and clears canonical read keys', async () => {
    const message = {
      from: 'alice', to: 'user', source: 'runtime_delivery',
      relayOfMessageId: 'delivery-1', timestamp: '2026-11-23T12:00:00Z', read: false,
    };
    const text = 'x'.repeat(260);
    const facade = createUserAttentionFeature({
      getContextId: () => 'local',
      getTeamDataService: () => ({
        listTeams: async () => [{ teamName: 'alpha', displayName: 'Alpha',
          members: [{ name: 'alice' }] }],
        getUserAttentionTasks: async () => [],
        getMessageFeed: async () => ({ teamName: 'alpha', feedRevision: '1', messages: [
          { ...message, messageId: 'canonical', text: text + ' answer' },
          { ...message, messageId: 'copy', text: ' ' + text + '  answer ' },
          { ...message, messageId: 'distinct', text: text + ' other' },
          { ...message, messageId: 'another-delivery', relayOfMessageId: 'delivery-2',
            text: text + ' answer' },
          { ...message, messageId: 'relay-of-original', relayOfMessageId: 'original',
            text: 'Same visible original' },
          { ...message, messageId: 'original', relayOfMessageId: undefined,
            text: 'Same visible original' },
        ] }),
      } as never),
    });
    const snapshot = await facade.getUserAttentionSnapshot();
    expect(snapshot.teams[0].messages.map((item) => item.messageId)).toEqual([
      'canonical', 'distinct', 'another-delivery', 'original',
    ]);
    const build = (direct: string[]) => buildAttentionModel(snapshot, () => ({
      direct: new Set(direct), group: new Set(),
    }), (item) => item.messageId ?? '');
    expect(build([]).unreadMessageCount).toBe(4);
    expect(build(['canonical', 'distinct', 'another-delivery', 'original']).unreadMessageCount).toBe(0);
  });

  it('fences a root switch during in-flight reads', async () => {
    let context = 'root-1';
    let markStarted!: () => void;
    const started = new Promise<void>((done) => { markStarted = done; });
    let resolve!: (value: { teamName: string; feedRevision: string; messages: [] }) => void;
    const pending = new Promise<{ teamName: string; feedRevision: string; messages: [] }>((done) => {
      resolve = done;
    });
    const facade = createUserAttentionFeature({
      getContextId: () => context,
      getTeamDataService: () => ({
        listTeams: async () => [{ teamName: 'x', displayName: 'X' }],
        getUserAttentionTasks: async () => [],
        getMessageFeed: () => { markStarted(); return pending; },
      } as never),
    });
    const request = facade.getUserAttentionSnapshot();
    await started;
    context = 'root-2';
    resolve({ teamName: 'x', feedRevision: '1', messages: [] });
    await expect(request).rejects.toThrow('context changed');
  });
});
