import { beforeEach, describe, expect, it } from 'vitest';

import {
  defaultTaskFiltersState,
  type TaskFiltersState,
  type TaskStatusFilterId,
} from '../../../../src/renderer/components/sidebar/taskFiltersState';
import {
  filterGlobalTasks,
  sortGlobalTasks,
} from '../../../../src/renderer/components/sidebar/taskViewPolicy';
import { selectLeadOfflineTeamNames } from '../../../../src/renderer/components/sidebar/teamActivitySelectors';
import { getSnapshot, markTaskUnread } from '../../../../src/renderer/services/commentReadStorage';

import type { GlobalTask } from '../../../../src/shared/types';

const task = (
  id: string,
  overrides: Partial<GlobalTask> = {}
): GlobalTask => {
  const base: GlobalTask = {
    id,
    teamName: 'team-a',
    teamDisplayName: 'Team A',
    subject: `Subject ${id}`,
    owner: 'owner',
    status: 'pending',
    reviewState: 'none',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    projectPath: '/work/alpha',
    comments: [],
  };
  return Object.assign(base, overrides);
};

const filters = (overrides: Partial<TaskFiltersState> = {}): TaskFiltersState =>
  Object.assign(defaultTaskFiltersState(), overrides);
const contextId = 'local';
const identity = (teamName: string, taskId: string) => ({
  contextId,
  teamName,
  taskId,
});
const comment = (id: string) => ({
  id,
  author: 'author',
  text: 'comment',
  createdAt: 'now',
  type: 'regular' as const,
});

describe('shared task view policy', () => {
  beforeEach(() => localStorage.clear());

  it('preserves sidebar project/status/team/read/search/archive semantics without mutating inputs', () => {
    const unread = task('unread', { subject: 'Find me', comments: [comment('c')] });
    const read = task('read');
    const otherTeam = task('other', { teamName: 'team-b', teamDisplayName: 'Team B' });
    const wrongProject = task('wrong', { projectPath: '/work/beta/' });
    markTaskUnread(identity('team-a', 'unread'));
    const source = [unread, read, otherTeam, wrongProject];
    const statusIds = new Set<TaskStatusFilterId>(['todo']);
    const policyFilters = filters({
      statusIds,
      teamName: 'team-a',
      projectPath: '/work/alpha',
      readFilter: 'unread',
      unreadOnly: true,
    });

    expect(
      filterGlobalTasks(
        source,
        { contextId, filters: policyFilters, searchQuery: 'find', archiveMode: 'active' },
        getSnapshot(),
        (candidate) => candidate.id === 'wrong'
      ).map((candidate) => candidate.id)
    ).toEqual(['unread']);
    expect(source.map((candidate) => candidate.id)).toEqual([
      'unread',
      'read',
      'other',
      'wrong',
    ]);
    expect([...statusIds]).toEqual(['todo']);
  });

  it('matches existing time team-freshness and unread tie ordering', () => {
    const olderTeamTask = task('older-team', {
      teamName: 'old',
      teamDisplayName: 'Old',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const newerTeamTask = task('newer-team', {
      teamName: 'new',
      teamDisplayName: 'New',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    const newerSameTeam = task('same-new', {
      teamName: 'new',
      teamDisplayName: 'New',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
    const source = [olderTeamTask, newerTeamTask, newerSameTeam];

    expect(sortGlobalTasks(source, 'time', contextId).map((candidate) => candidate.id)).toEqual([
      'same-new',
      'newer-team',
      'older-team',
    ]);
    expect(source.map((candidate) => candidate.id)).toEqual([
      'older-team',
      'newer-team',
      'same-new',
    ]);
  });

  it('keeps empty status selections strict and read filters comment-state based', () => {
    const unread = task('unread', { comments: [comment('c')] });
    markTaskUnread(identity('team-a', 'unread'));
    expect(
      filterGlobalTasks(
        [unread],
        {
          contextId,
          filters: filters({
            statusIds: new Set<TaskStatusFilterId>(),
            readFilter: 'unread',
            unreadOnly: true,
          }),
          searchQuery: '',
          archiveMode: 'all',
        },
        getSnapshot()
      )
    ).toEqual([]);
    expect(
      filterGlobalTasks(
        [unread],
        {
          contextId,
          filters: filters({ readFilter: 'read' }),
          searchQuery: '',
          archiveMode: 'all',
        },
        getSnapshot()
      )
    ).toEqual([]);
  });

  it('shares a sorted pure lead-offline projection with both task surfaces', () => {
    const input = {
      zebra: 'offline',
      alpha: 'offline',
      active: 'active',
      idle: 'idle',
    } as const;

    expect(selectLeadOfflineTeamNames(input)).toEqual(['alpha', 'zebra']);
    expect(input).toEqual({
      zebra: 'offline',
      alpha: 'offline',
      active: 'active',
      idle: 'idle',
    });
    expect(selectLeadOfflineTeamNames(input)).not.toBe(selectLeadOfflineTeamNames(input));
  });
});
