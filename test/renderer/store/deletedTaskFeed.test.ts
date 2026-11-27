import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import { createDeletedTaskFeed } from '../../../src/renderer/store/slices/deletedTaskFeed';
import { invalidateContextScopedRequestEpoch } from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

import type { DeletedTaskFeed } from '../../../src/renderer/store/slices/deletedTaskFeed';
import type { AppState } from '../../../src/renderer/store/types';
import type { TeamTask } from '../../../src/shared/types';

const { getDeletedTasks } = vi.hoisted(() => ({ getDeletedTasks: vi.fn() }));

vi.mock('@renderer/api', () => ({ api: { teams: { getDeletedTasks } } }));

type DeletedTeam = AppState['teams'][number];

interface FeedHarness extends DeletedTaskFeed {
  teams: DeletedTeam[];
  activeContextId: string;
}

function team(teamName: string): DeletedTeam {
  return { teamName, displayName: teamName } as DeletedTeam;
}

function deletedTask(id: string): TeamTask {
  return { id, subject: `Deleted ${id}`, status: 'deleted' };
}

function createFeedStore(teams: DeletedTeam[]) {
  return create<FeedHarness>()((set, get, store) => ({
    ...createDeletedTaskFeed(set as never, get as never, store as never),
    teams,
    activeContextId: 'local',
  }));
}

function createDeferred<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: (value: T): void => resolveValue(value) };
}

describe('deletedTaskFeed', () => {
  beforeEach(() => {
    getDeletedTasks.mockReset();
  });

  it('keeps deleted tasks from healthy teams when one team fails', async () => {
    getDeletedTasks.mockImplementation((teamName: string) =>
      teamName === 'beta'
        ? Promise.reject(new Error('team offline'))
        : Promise.resolve([deletedTask('task-alpha')])
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = createFeedStore([team('alpha'), team('beta')]);

    await store.getState().fetchAllDeletedTasks();

    expect(getDeletedTasks).toHaveBeenCalledTimes(2);
    expect(store.getState().globalDeletedTasks.map((task) => task.id)).toEqual(['task-alpha']);
  });

  it('includes verified project histories with native restoration identity and correct path', async () => {
    const logical = {
      ...team('builders'), displayName: 'Builders', projectPath: '/projects/default',
      projectHistoryContexts: [
        { executionTeamName: 'ptc-a', projectPath: '/projects/a' },
        { executionTeamName: 'ptc-b', projectPath: '/projects/b' },
      ],
    };
    getDeletedTasks.mockImplementation(async (name: string) => {
      if (name === 'builders') return [deletedTask('shared')];
      if (name === 'ptc-a' || name === 'ptc-b') return [deletedTask('1')];
      return [];
    });
    const store = createFeedStore([logical]);

    await store.getState().fetchAllDeletedTasks();

    expect(getDeletedTasks.mock.calls.map((args: string[]) => args[0])).toEqual([
      'builders', 'ptc-a', 'ptc-b',
    ]);
    expect(store.getState().globalDeletedTasks.map((task) => ({
      teamName: task.teamName, teamDisplayName: task.teamDisplayName,
      taskId: task.id, projectPath: task.projectPath,
    }))).toEqual([
      { teamName: 'builders', teamDisplayName: 'Builders', taskId: 'shared',
        projectPath: '/projects/default' },
      { teamName: 'ptc-a', teamDisplayName: 'Builders', taskId: '1',
        projectPath: '/projects/a' },
      { teamName: 'ptc-b', teamDisplayName: 'Builders', taskId: '1',
        projectPath: '/projects/b' },
    ]);
  });

  it('drops deleted-task results when the context changes during the fetch', async () => {
    const deferred = createDeferred<TeamTask[]>();
    getDeletedTasks.mockImplementation(() => deferred.promise);
    const store = createFeedStore([team('alpha')]);

    const pending = store.getState().fetchAllDeletedTasks();
    invalidateContextScopedRequestEpoch();
    store.setState({ activeContextId: 'ssh-workspace' });
    deferred.resolve([deletedTask('task-alpha')]);
    await pending;

    expect(store.getState().globalDeletedTasks).toEqual([]);
  });

  it('starts a new-context refresh without waiting for the stale context request', async () => {
    const stale = createDeferred<TeamTask[]>();
    let calls = 0;
    getDeletedTasks.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? stale.promise : Promise.resolve([deletedTask('task-beta')]);
    });
    const store = createFeedStore([team('alpha')]);

    const staleRefresh = store.getState().fetchAllDeletedTasks();
    store.setState({ activeContextId: 'ssh-workspace' });
    await store.getState().fetchAllDeletedTasks();

    expect(store.getState().globalDeletedTasks.map((task) => task.id)).toEqual(['task-beta']);

    stale.resolve([deletedTask('task-alpha')]);
    await staleRefresh;

    expect(store.getState().globalDeletedTasks.map((task) => task.id)).toEqual(['task-beta']);
  });
});
