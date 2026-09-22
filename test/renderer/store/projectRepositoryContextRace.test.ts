import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import { createProjectSlice } from '../../../src/renderer/store/slices/projectSlice';
import { createRepositorySlice } from '../../../src/renderer/store/slices/repositorySlice';
import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

import type { AppState } from '../../../src/renderer/store/types';
import type { Project, RepositoryGroup } from '../../../src/renderer/types/data';

const apiMock = vi.hoisted(() => ({
  getProjects: vi.fn(),
  getRepositoryGroups: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: apiMock,
}));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function project(id: string, path = `/${id}`): Project {
  return {
    id,
    path,
    name: id,
    sessions: [],
    totalSessions: 0,
    createdAt: 0,
    mostRecentSession: 0,
  };
}

function repositoryGroup(id: string, path = `/${id}`): RepositoryGroup {
  return {
    id,
    identity: null,
    name: id,
    totalSessions: 0,
    mostRecentSession: 0,
    worktrees: [
      {
        id: `${id}-worktree`,
        path,
        name: id,
        isMainWorktree: true,
        source: 'unknown',
        sessions: [],
        totalSessions: 0,
        createdAt: 0,
        mostRecentSession: 0,
      },
    ],
  };
}

function createProjectRepositoryStore() {
  return create<AppState>()((set, get, store) =>
    ({
      ...createProjectSlice(set as never, get as never, store as never),
      ...createRepositorySlice(set as never, get as never, store as never),
      activeContextId: 'local',
      activeProjectId: null,
      fetchSessionsInitial: vi.fn(async () => undefined),
    }) as unknown as AppState
  );
}

describe('project and repository context races', () => {
  beforeEach(() => {
    resetContextScopedRequestEpochForTests();
    apiMock.getProjects.mockReset();
    apiMock.getRepositoryGroups.mockReset();
  });

  afterEach(() => {
    resetContextScopedRequestEpochForTests();
    vi.restoreAllMocks();
  });

  it('applies current-context project loads', async () => {
    const store = createProjectRepositoryStore();
    apiMock.getProjects.mockResolvedValue([project('current-project')]);

    await store.getState().fetchProjects();

    expect(store.getState().projects).toEqual([project('current-project')]);
    expect(store.getState().projectsInitialized).toBe(true);
    expect(store.getState().projectsLoading).toBe(false);
  });

  it('clears stale grouped project selection when selecting a flat project', () => {
    const store = createProjectRepositoryStore();
    store.setState({
      activeProjectId: 'repo-worktree',
      selectedProjectId: 'repo-worktree',
      selectedRepositoryId: 'repo',
      selectedWorktreeId: 'repo-worktree',
    });

    store.getState().selectProject('flat-project');

    expect(store.getState()).toEqual(
      expect.objectContaining({
        activeProjectId: 'flat-project',
        selectedProjectId: 'flat-project',
        selectedRepositoryId: null,
        selectedWorktreeId: null,
      })
    );
    expect(store.getState().fetchSessionsInitial).toHaveBeenCalledWith('flat-project');
  });

  it('ignores project loads resolved for a previous context', async () => {
    const store = createProjectRepositoryStore();
    const localProjects = deferred<Project[]>();
    const currentProjects = [project('ssh-project', '/ssh/project')];
    apiMock.getProjects.mockReturnValueOnce(localProjects.promise);

    const fetchPromise = store.getState().fetchProjects();
    expect(store.getState().projectsLoading).toBe(true);

    store.setState({
      activeContextId: 'ssh-dev',
      projects: currentProjects,
      projectsLoading: false,
      projectsInitialized: true,
    });
    localProjects.resolve([project('local-project', '/local/project')]);
    await fetchPromise;

    expect(store.getState().projects).toBe(currentProjects);
    expect(store.getState().projectsLoading).toBe(false);
  });

  it('ignores project loads resolved before a same-context epoch reset', async () => {
    const store = createProjectRepositoryStore();
    const oldLocalProjects = deferred<Project[]>();
    const currentProjects = [project('fresh-local-project', '/fresh-local/project')];
    apiMock.getProjects.mockReturnValueOnce(oldLocalProjects.promise);

    const fetchPromise = store.getState().fetchProjects();
    expect(store.getState().projectsLoading).toBe(true);

    invalidateContextScopedRequestEpoch();
    store.setState({
      activeContextId: 'local',
      projects: currentProjects,
      projectsLoading: false,
      projectsInitialized: true,
    });
    oldLocalProjects.resolve([project('old-local-project', '/old-local/project')]);
    await fetchPromise;

    expect(store.getState().projects).toBe(currentProjects);
    expect(store.getState().projectsLoading).toBe(false);
  });

  it('applies current-context repository group loads', async () => {
    const store = createProjectRepositoryStore();
    apiMock.getRepositoryGroups.mockResolvedValue([repositoryGroup('current-repo')]);

    await store.getState().fetchRepositoryGroups();

    expect(store.getState().repositoryGroups).toEqual([repositoryGroup('current-repo')]);
    expect(store.getState().repositoryGroupsInitialized).toBe(true);
    expect(store.getState().repositoryGroupsLoading).toBe(false);
  });

  it('ignores repository group loads resolved for a previous context', async () => {
    const store = createProjectRepositoryStore();
    const localGroups = deferred<RepositoryGroup[]>();
    const currentGroups = [repositoryGroup('ssh-repo', '/ssh/repo')];
    apiMock.getRepositoryGroups.mockReturnValueOnce(localGroups.promise);

    const fetchPromise = store.getState().fetchRepositoryGroups();
    expect(store.getState().repositoryGroupsLoading).toBe(true);

    store.setState({
      activeContextId: 'ssh-dev',
      repositoryGroups: currentGroups,
      repositoryGroupsLoading: false,
      repositoryGroupsInitialized: true,
    });
    localGroups.resolve([repositoryGroup('local-repo', '/local/repo')]);
    await fetchPromise;

    expect(store.getState().repositoryGroups).toBe(currentGroups);
    expect(store.getState().repositoryGroupsLoading).toBe(false);
  });

  it('ignores repository group loads resolved before a same-context epoch reset', async () => {
    const store = createProjectRepositoryStore();
    const oldLocalGroups = deferred<RepositoryGroup[]>();
    const currentGroups = [repositoryGroup('fresh-local-repo', '/fresh-local/repo')];
    apiMock.getRepositoryGroups.mockReturnValueOnce(oldLocalGroups.promise);

    const fetchPromise = store.getState().fetchRepositoryGroups();
    expect(store.getState().repositoryGroupsLoading).toBe(true);

    invalidateContextScopedRequestEpoch();
    store.setState({
      activeContextId: 'local',
      repositoryGroups: currentGroups,
      repositoryGroupsLoading: false,
      repositoryGroupsInitialized: true,
    });
    oldLocalGroups.resolve([repositoryGroup('old-local-repo', '/old-local/repo')]);
    await fetchPromise;

    expect(store.getState().repositoryGroups).toBe(currentGroups);
    expect(store.getState().repositoryGroupsLoading).toBe(false);
  });
});
