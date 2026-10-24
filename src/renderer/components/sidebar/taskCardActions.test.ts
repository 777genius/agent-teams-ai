import { describe, expect, it, vi } from 'vitest';

import { buildTaskCardActions } from './taskCardActions';
import { defaultTaskFiltersState, type TaskFiltersState } from './taskFiltersState';
import { filterGlobalTasks } from './taskViewPolicy';

import type { useReadStateSnapshot } from './taskFiltersState';
import type { GlobalTask } from '@shared/types';

const handlers = {
  onTogglePin: vi.fn(),
  onMove: vi.fn(),
  onRename: vi.fn(),
  onMarkUnread: vi.fn(),
  onToggleArchive: vi.fn(),
  onDelete: vi.fn(),
  onRestore: vi.fn(),
};

function task(overrides: Partial<GlobalTask> = {}): GlobalTask {
  return {
    id: 'task-1',
    teamName: 'team-a',
    teamDisplayName: 'Team A',
    subject: 'Example task',
    status: 'pending',
    ...overrides,
  } as GlobalTask;
}

function filters(overrides: Partial<TaskFiltersState> = {}): TaskFiltersState {
  return { ...defaultTaskFiltersState(), ...overrides };
}

const readState = {} as ReturnType<typeof useReadStateSnapshot>;

describe('buildTaskCardActions for deleted tasks', () => {
  it('offers only restore for a deleted task', () => {
    const actions = buildTaskCardActions({
      isPinned: true,
      isArchived: true,
      isDeleted: true,
      handlers,
    });
    expect(actions.map((action) => action.id)).toEqual(['restore']);
    expect(actions[0].labelKey).toBe('taskContextMenu.restoreTask');
    actions[0].run();
    expect(handlers.onRestore).toHaveBeenCalledTimes(1);
  });

  it('offers no actions for a deleted task without a restore handler', () => {
    expect(
      buildTaskCardActions({
        isPinned: false,
        isArchived: false,
        isDeleted: true,
        handlers: {
          onTogglePin: handlers.onTogglePin,
          onMove: handlers.onMove,
          onRename: handlers.onRename,
          onMarkUnread: handlers.onMarkUnread,
          onToggleArchive: handlers.onToggleArchive,
        },
      })
    ).toEqual([]);
  });
});

describe('filterGlobalTasks deleted gating', () => {
  const deleted = task({ id: 'del-1', status: 'deleted' });
  const active = task({ id: 'act-1', status: 'pending' });

  it('reveals deleted tasks only when showDeleted is on', () => {
    const policy = { contextId: 'ctx', searchQuery: '', archiveMode: 'active' as const };
    expect(
      filterGlobalTasks([deleted, active], { ...policy, filters: filters() }, readState)
    ).toEqual([active]);
    expect(
      filterGlobalTasks(
        [deleted, active],
        { ...policy, filters: filters({ showDeleted: true }) },
        readState
      )
    ).toEqual([deleted, active]);
  });

  it('keeps deleted tasks visible regardless of archive mode', () => {
    const policy = {
      contextId: 'ctx',
      searchQuery: '',
      filters: filters({ showDeleted: true }),
    };
    const archivedDeleted = task({ id: 'del-2', status: 'deleted' });
    const isArchived = (t: GlobalTask): boolean => t.id === 'del-2';
    for (const archiveMode of ['active', 'archived', 'all'] as const) {
      expect(
        filterGlobalTasks([archivedDeleted], { ...policy, archiveMode }, readState, isArchived)
      ).toEqual([archivedDeleted]);
    }
  });
});
