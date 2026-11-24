import {
  attentionFilterCount,
  attentionTeamOptions,
  DEFAULT_ATTENTION_FILTERS,
  filterAttentionEntries,
  type AttentionFilters,
} from '@features/user-attention/renderer/view-models/filterAttentionEntries';
import { describe, expect, it } from 'vitest';

import type { AttentionModel } from '@features/user-attention/core/domain/buildAttention';

const now = Date.parse('2026-11-24T18:00:00Z');
const model: AttentionModel = {
  tasks: [
    { teamName: 'alpha', teamDisplayName: 'Alpha', taskId: 'old',
      subject: 'Approve release', requestedAt: '2026-11-20T12:00:00Z' },
    { teamName: 'beta', teamDisplayName: 'Beta', taskId: 'today',
      subject: 'Choose database', requestedAt: '2026-11-24T12:00:00Z' },
    { teamName: 'alpha', teamDisplayName: 'Alpha', taskId: 'legacy',
      subject: 'Older request with no date', requestedAt: null },
  ],
  chats: [
    { teamName: 'beta', teamDisplayName: 'Beta', name: 'Maya',
      scope: { kind: 'direct', participant: 'maya' }, unreadCount: 2,
      latestUnread: { messageId: 'a', from: 'maya', to: 'user',
        text: 'PostgreSQL?', timestamp: '2026-11-24T17:00:00Z', read: false } },
    { teamName: 'alpha', teamDisplayName: 'Alpha', name: 'Release group',
      scope: { kind: 'group', groupChatId: 'release' }, unreadCount: 1,
      latestUnread: { messageId: 'b', from: 'alex', to: 'user',
        text: 'Approval needed', timestamp: '2026-11-23T10:00:00Z', read: false } },
    { teamName: 'alpha', teamDisplayName: 'Alpha', name: 'Team feed',
      scope: { kind: 'team-feed' }, unreadCount: 1,
      latestUnread: { messageId: 'c', from: 'former-member', to: 'user',
        text: 'Review the logs', timestamp: '2026-11-22T10:00:00Z', read: false } },
  ],
  taskCount: 3,
  chatCount: 3,
  unreadMessageCount: 4,
  complete: true,
  countsByTeam: new Map([['alpha', { tasks: 2, chats: 2 }], ['beta', { tasks: 1, chats: 1 }]]),
};

const filtered = (overrides: Partial<AttentionFilters> = {}, search = '') =>
  filterAttentionEntries(model, { ...DEFAULT_ATTENTION_FILTERS, ...overrides }, search, now);

describe('full Attention Inbox filter policy', () => {
  it('leaves the compact/default priority order untouched', () => {
    const result = filtered();
    expect(result.tasks.map((task) => task.taskId)).toEqual(['old', 'today', 'legacy']);
    expect(result.chats.map((chat) => chat.scope.kind)).toEqual(['direct', 'group', 'team-feed']);
    expect(result.tasks[0]).toBe(model.tasks[0]);
    expect(result.chats[0]).toBe(model.chats[0]);
  });

  it('combines item type, team and text search without changing the model', () => {
    expect(filtered({ type: 'tasks', teamName: 'alpha' }, 'approve').tasks
      .map((task) => task.taskId)).toEqual(['old']);
    expect(filtered({ type: 'tasks', teamName: 'alpha' }, 'approve').chats).toEqual([]);
    expect(filtered({ type: 'chats', teamName: 'beta' }, 'postgresql').chats
      .map((chat) => chat.name)).toEqual(['Maya']);
    expect(filtered({ type: 'chats' }, 'nothing')).toEqual({ tasks: [], chats: [] });
    expect(model.tasks).toHaveLength(3);
    expect(model.chats).toHaveLength(3);
  });

  it('filters direct, group and team-feed chats by canonical scope', () => {
    for (const scope of ['direct', 'group', 'team-feed'] as const) {
      const result = filtered({ conversation: scope });
      expect(result.chats).toHaveLength(1);
      expect(result.chats[0].scope.kind).toBe(scope);
      expect(result.tasks).toHaveLength(3);
    }
  });

  it('excludes unknown dates only when filtering by task wait duration', () => {
    expect(filtered({ waiting: 'day' }).tasks.map((task) => task.taskId))
      .toEqual(['old']);
    expect(filtered({ waiting: 'week' }).tasks).toEqual([]);
    expect(filtered({ waiting: 'day' }).chats).toHaveLength(3);
    expect(filtered({ waiting: 'day', type: 'chats' }).chats).toHaveLength(3);
    expect(filterAttentionEntries({
      ...model, tasks: [{ ...model.tasks[0], requestedAt: 'invalid' }],
    }, { ...DEFAULT_ATTENTION_FILTERS, waiting: 'day' }, '', now).tasks).toHaveLength(0);
  });

  it('deduplicates team choices across both sections, ordered by display name', () => {
    expect(attentionTeamOptions(model)).toEqual([
      { teamName: 'alpha', displayName: 'Alpha' },
      { teamName: 'beta', displayName: 'Beta' },
    ]);
    expect(attentionTeamOptions(null)).toEqual([]);
  });

  it('groups execution aliases by visible team for options and filtering without rewriting source identity', () => {
    const aliasTask = {
      ...model.tasks[0], teamName: 'alpha-execution', logicalTeamName: 'alpha',
      taskId: 'alias-task',
    };
    const aliasChat = {
      ...model.chats[1], teamName: 'alpha-execution', logicalTeamName: 'alpha',
    };
    const aliasOnlyTask = {
      ...model.tasks[0], teamName: 'gamma-execution', logicalTeamName: 'gamma',
      teamDisplayName: 'Gamma', taskId: 'gamma-task',
    };
    const aliasOnlyChat = {
      ...model.chats[1], teamName: 'gamma-execution', logicalTeamName: 'gamma',
      teamDisplayName: 'Gamma',
    };
    const withAliases: AttentionModel = {
      ...model,
      tasks: [...model.tasks, aliasTask, aliasOnlyTask],
      chats: [...model.chats, aliasChat, aliasOnlyChat],
    };

    expect(attentionTeamOptions(withAliases)).toEqual([
      { teamName: 'alpha', displayName: 'Alpha' },
      { teamName: 'beta', displayName: 'Beta' },
      { teamName: 'gamma', displayName: 'Gamma' },
    ]);
    const selectTeam = (teamName: string) => filterAttentionEntries(
      withAliases, { ...DEFAULT_ATTENTION_FILTERS, teamName }, '', now
    );
    expect(selectTeam('alpha').tasks).toEqual([model.tasks[0], model.tasks[2], aliasTask]);
    expect(selectTeam('alpha').chats).toEqual([model.chats[1], model.chats[2], aliasChat]);
    expect(selectTeam('gamma')).toEqual({ tasks: [aliasOnlyTask], chats: [aliasOnlyChat] });
    expect(selectTeam('alpha').tasks[2]).toBe(aliasTask);
    expect(selectTeam('alpha').chats[2]).toBe(aliasChat);
    expect(selectTeam('alpha-execution')).toEqual({ tasks: [], chats: [] });
  });

  it('counts only active criteria and preserves reset defaults', () => {
    expect(attentionFilterCount(DEFAULT_ATTENTION_FILTERS)).toBe(0);
    expect(attentionFilterCount({
      type: 'chats', teamName: 'beta', conversation: 'group', waiting: 'week',
    })).toBe(4);
  });
});
