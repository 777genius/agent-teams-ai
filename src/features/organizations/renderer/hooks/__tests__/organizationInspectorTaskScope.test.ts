import { describe, expect, it } from 'vitest';

import {
  collectExecutionTeamNames,
  groupTasksByOwner,
  matchesTaskSummary,
  scopeInspectorTasks,
  taskOwnerTeam,
  type InspectorScopedTask,
} from '../organizationInspectorTaskScope';

import type { OrganizationAgentSummaryDto, OrganizationAgentTaskDto } from '../../../contracts';
import type { TeamTaskWithKanban } from '@shared/types';

const task = (id: string, teamName?: string, displayId?: string) =>
  ({ id, displayId, subject: id, status: 'in_progress', teamName }) as InspectorScopedTask;

const summary = (id: string, executionTeamName?: string) =>
  ({ id, subject: id, status: 'in_progress', executionTeamName }) as OrganizationAgentTaskDto;

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

describe('task identity across project copies', () => {
  it('names the copy that owns a task, falling back to the node team', () => {
    expect(taskOwnerTeam(task('1', 'ptc-a'), 'builders')).toBe('ptc-a');
    expect(taskOwnerTeam(task('1'), 'builders')).toBe('builders');
  });

  it('matches a summary only to the task of the copy it names, even when ids repeat', () => {
    const inA = task('1', 'ptc-a');
    const inB = task('1', 'ptc-b');
    expect(matchesTaskSummary(inA, summary('1', 'ptc-b'))).toBe(false);
    expect(matchesTaskSummary(inB, summary('1', 'ptc-b'))).toBe(true);
    // An ordinary team's summary names no copy and matches by id or display id.
    expect(matchesTaskSummary(task('1', 'legacy'), summary('1'))).toBe(true);
    expect(matchesTaskSummary(task('x', 'legacy', '#1'), summary('#1'))).toBe(true);
    expect(matchesTaskSummary(task('2', 'legacy'), summary('1'))).toBe(false);
  });

  it('keeps the tasks of each copy apart, so a lookup never crosses into another copy', () => {
    const byOwner = groupTasksByOwner([task('1', 'ptc-a'), task('1', 'ptc-b'), task('2', 'ptc-b')], 'builders');
    expect([...(byOwner.get('ptc-a')?.keys() ?? [])]).toEqual(['1']);
    expect([...(byOwner.get('ptc-b')?.keys() ?? [])]).toEqual(['1', '2']);
    expect(byOwner.get('ptc-a')?.get('1')).not.toBe(byOwner.get('ptc-b')?.get('1'));
    expect([...groupTasksByOwner([task('9')], 'legacy').keys()]).toEqual(['legacy']);
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
