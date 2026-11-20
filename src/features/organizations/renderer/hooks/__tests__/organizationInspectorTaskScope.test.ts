import { describe, expect, it } from 'vitest';

import {
  collectExecutionTeamNames,
  executionTeamOfTask,
  scopeInspectorTasks,
  type InspectorScopedTask,
} from '../organizationInspectorTaskScope';

import type { OrganizationAgentSummaryDto } from '../../../contracts';
import type { TeamTaskWithKanban } from '@shared/types';

const task = (id: string, teamName?: string) =>
  ({ id, subject: id, status: 'in_progress', teamName }) as InspectorScopedTask;

const agent = (tasks: Array<{ id: string; executionTeamName?: string }>) =>
  ({
    id: 'a',
    teamName: 'builders',
    name: 'alice',
    status: 'active',
    activeTaskCount: tasks.length,
    currentTasks: tasks.map((entry) => ({ subject: entry.id, status: 'in_progress', ...entry })),
  }) as OrganizationAgentSummaryDto;

describe('scopeInspectorTasks', () => {
  const globalTasks = [task('1', 'ptc-a'), task('2', 'ptc-b'), task('3', 'legacy'), task('4', 'builders')];

  it('finds the tasks of a per-project team in its project copies', () => {
    const tasks = scopeInspectorTasks({
      teamName: 'builders',
      executionTeamNames: ['ptc-a', 'ptc-b'],
      teamDataTasks: undefined,
      globalTasks,
    });
    expect(tasks.map((entry) => entry.id)).toEqual(['1', '2', '4']);
  });

  it('keeps an ordinary team on its own loaded board, else on its global tasks', () => {
    const board = [task('7')] as TeamTaskWithKanban[];
    expect(
      scopeInspectorTasks({ teamName: 'legacy', executionTeamNames: [], teamDataTasks: board, globalTasks })
    ).toBe(board);
    expect(
      scopeInspectorTasks({ teamName: 'legacy', executionTeamNames: [], teamDataTasks: undefined, globalTasks })
        .map((entry) => entry.id)
    ).toEqual(['3']);
  });

  it('shows nothing for a node without a team', () => {
    expect(
      scopeInspectorTasks({ teamName: '', executionTeamNames: ['ptc-a'], teamDataTasks: undefined, globalTasks })
    ).toEqual([]);
  });
});

describe('executionTeamOfTask', () => {
  it('runs a task action against the copy that owns the task, not the team the node shows', () => {
    const tasks = [task('1', 'ptc-a'), task('2', 'ptc-b')];
    expect(executionTeamOfTask(tasks, '2', 'builders')).toBe('ptc-b');
  });

  it('falls back to the node team for a task without an owner', () => {
    expect(executionTeamOfTask([task('1')], '1', 'builders')).toBe('builders');
    expect(executionTeamOfTask([], 'missing', 'builders')).toBe('builders');
  });
});

describe('collectExecutionTeamNames', () => {
  it('lists each owning copy once, and none for an ordinary team', () => {
    expect(
      collectExecutionTeamNames([
        agent([{ id: '1', executionTeamName: 'ptc-b' }, { id: '2', executionTeamName: 'ptc-a' }]),
        agent([{ id: '3', executionTeamName: 'ptc-a' }, { id: '4' }]),
      ])
    ).toEqual(['ptc-a', 'ptc-b']);
    expect(collectExecutionTeamNames([agent([{ id: '1' }])])).toEqual([]);
  });
});
