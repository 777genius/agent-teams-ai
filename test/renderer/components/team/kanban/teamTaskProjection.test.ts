import { describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_GROUP_CHAT_ID } from '../../../../../src/features/team-group-chats/contracts';
import {
  buildTaskGroupOptions,
  getTaskColumn,
  projectTeamTasks,
} from '../../../../../src/renderer/components/team/kanban/teamTaskProjection';

import type { TeamGroupChatDTO } from '../../../../../src/features/team-group-chats/contracts';
import type { KanbanFilterState } from '../../../../../src/renderer/components/team/kanban/KanbanFilterPopover';
import type { KanbanState, TeamTaskWithKanban } from '../../../../../src/shared/types';

const task = (id: string, overrides: Partial<TeamTaskWithKanban> = {}): TeamTaskWithKanban => ({
  id,
  subject: id,
  status: 'pending',
  groupChatId: 'g',
  ...overrides,
});
const filter = (overrides: Partial<KanbanFilterState> = {}): KanbanFilterState => ({
  sessionId: null,
  selectedOwners: new Set(),
  columns: new Set(),
  ...overrides,
});
const group = (id: string, archivedAt: string | null = null): TeamGroupChatDTO => ({
  id,
  name: id === DEFAULT_TEAM_GROUP_CHAT_ID ? 'All' : id,
  archivedAt,
  createdAt: '',
  membership: { kind: 'fixed', memberNames: [] },
  memberNames: [],
  availableRecipientNames: [],
  canSend: false,
});
const overlay: KanbanState = {
  teamName: 'team',
  reviewers: [],
  tasks: {
    review: { column: 'review', movedAt: '2026-10-10T00:00:00Z' },
    approved: { column: 'approved', movedAt: '2026-10-10T00:00:00Z' },
  },
};

describe('team task group projection', () => {
  it('counts all nondeleted links, preserves selected zero/orphan and reserved groups while catalog loads', () => {
    const tasks = [
      task('a'),
      task('completed', { status: 'completed' }),
      task('deleted', { deletedAt: 'now' }),
      task('orphan', { groupChatId: 'missing' }),
      task('reserved', { groupChatId: DEFAULT_TEAM_GROUP_CHAT_ID }),
    ];
    const options = buildTaskGroupOptions(
      tasks,
      [group('g', 'now'), group(DEFAULT_TEAM_GROUP_CHAT_ID), group('unlinked')],
      true,
      'empty'
    );
    expect(options).toEqual([
      { id: 'g', name: 'g', archived: true, unavailable: false, count: 2 },
      { id: 'missing', name: undefined, archived: false, unavailable: true, count: 1 },
      {
        id: DEFAULT_TEAM_GROUP_CHAT_ID,
        name: 'All',
        archived: false,
        unavailable: false,
        count: 1,
      },
      { id: 'empty', name: undefined, archived: false, unavailable: true, count: 0 },
    ]);
    expect(
      buildTaskGroupOptions(tasks, [], false, null).every((option) => !option.unavailable)
    ).toBe(true);
    expect(projectTeamTasks(tasks, filter({ groupChatId: 'empty' }), null)).toEqual([]);
  });

  it('keeps all linked statuses in actual columns and combines group, owner and session constraints', () => {
    const cases = [
      task('todo'),
      task('progress', { status: 'in_progress' }),
      task('review', { status: 'completed' }),
      task('approved', { status: 'completed' }),
      task('done', { status: 'completed' }),
      task('fix', { status: 'completed', reviewState: 'needsFix' }),
      task('cleared', { status: 'completed', reviewState: 'review' }),
      task('deleted', { status: 'deleted' }),
    ];
    const linked = projectTeamTasks(cases, filter({ groupChatId: 'g' }), null);
    expect(linked.map((item) => [item.id, getTaskColumn(item, overlay)])).toEqual([
      ['todo', 'todo'],
      ['progress', 'in_progress'],
      ['review', 'review'],
      ['approved', 'approved'],
      ['done', 'done'],
      ['fix', 'done'],
      ['cleared', 'done'],
    ]);
    const scoped = [
      task('match', { owner: 'alice', createdAt: '2026-10-10T10:00:00Z' }),
      task('wrong-owner', { owner: 'bob' }),
      task('wrong-group', { owner: 'alice', groupChatId: 'other' }),
      task('old', { owner: 'alice', createdAt: '2020-01-01T00:00:00Z' }),
      task('legacy', { owner: 'alice' }),
    ];
    expect(
      projectTeamTasks(scoped, filter({ groupChatId: 'g', selectedOwners: new Set(['alice']) }), {
        start: Date.parse('2026-10-10'),
        end: Date.parse('2026-10-11'),
      }).map((item) => item.id)
    ).toEqual(['match', 'legacy']);
  });
});
