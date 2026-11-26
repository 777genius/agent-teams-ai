import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import { createProjectSlice } from '../../../src/renderer/store/slices/projectSlice';
import { createRepositorySlice } from '../../../src/renderer/store/slices/repositorySlice';
import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

import { createTestStore } from './storeTestUtils';

import type { AppState } from '../../../src/renderer/store/types';
import type { Project, RepositoryGroup } from '../../../src/renderer/types/data';

const apiMock = vi.hoisted(() => ({
  getProjects: vi.fn(),
  getRepositoryGroups: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: apiMock,
  isElectronMode: () => false,
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
  return create<AppState>()(
    (set, get, store) =>
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

function createTeamNavigationStore() {
  const teams = ['builders', 'old-team', 'new-team', 'first-team', 'second-team'].map(
    (teamName) => ({
      teamName,
      displayName: teamName,
      description: '',
      memberCount: 0,
      taskCount: 0,
      lastActivity: null,
      projectContextMode: 'per_project' as const,
      ownerResourceRef: 'TEST-original-owner',
    })
  );
  const store = createTestStore();
  store.setState({
    activeContextId: 'local',
    isContextSwitching: false,
    teams,
    teamByName: Object.fromEntries(teams.map((team) => [team.teamName, team])),
    // These two external data consumers are not navigation or catalog authority.
    fetchSessionsInitial: vi.fn(async () => undefined),
    selectTeam: vi.fn(async () => undefined),
  });
  return store;
}

describe('explicit Team project navigation', () => {
  beforeEach(() => {
    resetContextScopedRequestEpochForTests();
    apiMock.getProjects.mockReset();
    apiMock.getRepositoryGroups.mockReset();
  });

  afterEach(() => {
    resetContextScopedRequestEpochForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('hydrates one cold grouped catalog before selecting and opening the exact logical Team tab', async () => {
    const store = createTeamNavigationStore();
    const response = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);

    store.getState().openTeamTab('builders', '/TEST/project-b');
    expect(store.getState().getAllPaneTabs()).toHaveLength(0);
    expect(store.getState().selectedProjectId).toBeNull();
    expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(1);
    expect(apiMock.getProjects).not.toHaveBeenCalled();

    response.resolve([repositoryGroup('project-b', '/TEST/project-b')]);
    await vi.waitFor(() => expect(store.getState().repositoryGroupsLoading).toBe(false));

    expect(store.getState()).toMatchObject({
      selectedRepositoryId: 'project-b',
      selectedWorktreeId: 'project-b-worktree',
      selectedProjectId: 'project-b-worktree',
      activeProjectId: 'project-b-worktree',
    });
    const tabs = store.getState().getAllPaneTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ type: 'team', teamName: 'builders', label: 'builders' });
    expect(store.getState().activeTabId).toBe(tabs[0].id);
    expect(store.getState().fetchSessionsInitial).toHaveBeenCalledExactlyOnceWith(
      'project-b-worktree'
    );
  });

  it('observes an already in-flight grouped fetch without dispatching another fetch', async () => {
    const store = createTeamNavigationStore();
    const response = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);
    const pending = store.getState().fetchRepositoryGroups();

    store.getState().openTeamTab('builders', '/TEST/project-b');
    expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(1);
    response.resolve([repositoryGroup('project-b', '/TEST/project-b')]);
    await pending;

    expect(store.getState().selectedProjectId).toBe('project-b-worktree');
    expect(store.getState().fetchSessionsInitial).toHaveBeenCalledExactlyOnceWith(
      'project-b-worktree'
    );
    expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(1);
  });

  for (const kind of ['flat', 'grouped'] as const) {
    it(`selects a known ${kind} project synchronously without a catalog fetch`, () => {
      const store = createTeamNavigationStore();
      store.setState(
        kind === 'flat'
          ? { projects: [project('project-b', '/TEST/project-b')] }
          : { repositoryGroups: [repositoryGroup('project-b', '/TEST/project-b')] }
      );

      store.getState().openTeamTab('builders', '/TEST/project-b');

      expect(store.getState().selectedProjectId).toBe(
        kind === 'flat' ? 'project-b' : 'project-b-worktree'
      );
      expect(store.getState().getAllPaneTabs()).toHaveLength(1);
      expect(apiMock.getRepositoryGroups).not.toHaveBeenCalled();
      expect(apiMock.getProjects).not.toHaveBeenCalled();
      expect(store.getState().fetchSessionsInitial).toHaveBeenCalledTimes(1);
    });
  }

  for (const successor of [
    'context',
    'epoch',
    'project',
    'tab',
    'pane',
    'mode',
    'owner',
  ] as const) {
    it(`refuses delayed project selection after a ${successor} successor`, async () => {
      const store = createTeamNavigationStore();
      const response = deferred<RepositoryGroup[]>();
      apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);
      const pending = store.getState().fetchRepositoryGroups();
      store.getState().openTeamTab('builders', '/TEST/project-b');

      if (successor === 'context') store.setState({ activeContextId: 'ssh-other' });
      if (successor === 'epoch') invalidateContextScopedRequestEpoch();
      if (successor === 'project') store.getState().selectProject('user-project');
      if (successor === 'tab') store.getState().openTab({ type: 'dashboard', label: 'User tab' });
      if (successor === 'pane') {
        const layout = store.getState().paneLayout;
        store.setState({
          paneLayout: {
            ...layout,
            panes: [
              ...layout.panes,
              {
                id: 'user-pane',
                tabs: [],
                activeTabId: null,
                selectedTabIds: [],
                widthFraction: 0.5,
              },
            ],
          },
        });
        store.getState().focusPane('user-pane');
      }
      if (successor === 'mode' || successor === 'owner') {
        const summary = store.getState().teamByName.builders;
        store.setState({
          teamByName: {
            ...store.getState().teamByName,
            builders: {
              ...summary,
              ...(successor === 'mode'
                ? { projectContextMode: 'shared' }
                : { ownerResourceRef: 'TEST-new-owner' }),
            },
          },
        });
      }
      const selection = store.getState().selectedProjectId;
      const activeTabId = store.getState().activeTabId;
      const sessionCalls = vi.mocked(store.getState().fetchSessionsInitial).mock.calls.slice();
      response.resolve([repositoryGroup('project-b', '/TEST/project-b')]);
      await pending;

      expect(store.getState().selectedProjectId).toBe(selection);
      expect(store.getState().activeTabId).toBe(activeTabId);
      expect(vi.mocked(store.getState().fetchSessionsInitial).mock.calls).toEqual(sessionCalls);
      expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(1);
    });
  }

  for (const kind of ['shared', 'legacy', 'no-path'] as const) {
    it(`preserves synchronous ${kind} navigation without requesting a project catalog`, () => {
      const store = createTeamNavigationStore();
      if (kind === 'shared')
        store.setState({
          teamByName: {
            builders: {
              ...store.getState().teamByName.builders,
              projectContextMode: 'shared',
            },
          },
        });
      if (kind === 'legacy') store.setState({ teamByName: {} });

      store
        .getState()
        .openTeamTab('builders', kind === 'no-path' ? undefined : '/TEST/undiscovered');

      expect(store.getState().getAllPaneTabs()).toHaveLength(1);
      expect(store.getState().getAllPaneTabs()[0]).toMatchObject({
        type: 'team',
        teamName: 'builders',
      });
      expect(apiMock.getRepositoryGroups).not.toHaveBeenCalled();
      expect(apiMock.getProjects).not.toHaveBeenCalled();
    });
  }

  it('does not revive a cancelled intent when the user returns to its prior project', async () => {
    const store = createTeamNavigationStore();
    store.getState().selectProject('prior-project');
    vi.mocked(store.getState().fetchSessionsInitial).mockClear();
    const response = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);
    const pending = store.getState().fetchRepositoryGroups();
    store.getState().openTeamTab('builders', '/TEST/project-b');
    store.getState().selectProject('user-project');
    store.getState().selectProject('prior-project');
    response.resolve([repositoryGroup('project-b', '/TEST/project-b')]);
    await pending;

    expect(store.getState().selectedProjectId).toBe('prior-project');
    expect(vi.mocked(store.getState().fetchSessionsInitial).mock.calls).toEqual([
      ['user-project'],
      ['prior-project'],
    ]);
  });

  it('lets only the newer Team navigation select from one shared catalog result', async () => {
    const store = createTeamNavigationStore();
    const response = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);
    const pending = store.getState().fetchRepositoryGroups();
    store.getState().openTeamTab('old-team', '/TEST/old-project');
    store.getState().openTeamTab('new-team', '/TEST/new-project');
    response.resolve([
      repositoryGroup('old-project', '/TEST/old-project'),
      repositoryGroup('new-project', '/TEST/new-project'),
    ]);
    await pending;

    expect(store.getState().selectedProjectId).toBe('new-project-worktree');
    expect(store.getState().fetchSessionsInitial).toHaveBeenCalledExactlyOnceWith(
      'new-project-worktree'
    );
    expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(1);
    expect(
      store
        .getState()
        .getAllPaneTabs()
        .find((tab) => tab.id === store.getState().activeTabId)?.teamName
    ).toBe('new-team');
  });

  it('does not let an old completion displace a synchronously admitted newer Team navigation', async () => {
    const store = createTeamNavigationStore();
    const response = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);
    const pending = store.getState().fetchRepositoryGroups();
    const unsubscribe = store.subscribe((state) => {
      if (!state.repositoryGroupsInitialized) return;
      unsubscribe();
      state.openTeamTab('new-team', '/TEST/new-project');
    });
    store.getState().openTeamTab('old-team', '/TEST/old-project');
    response.resolve([
      repositoryGroup('old-project', '/TEST/old-project'),
      repositoryGroup('new-project', '/TEST/new-project'),
    ]);
    await pending;

    expect(store.getState().selectedProjectId).toBe('new-project-worktree');
    expect(store.getState().fetchSessionsInitial).toHaveBeenCalledExactlyOnceWith(
      'new-project-worktree'
    );
  });

  it('refuses the old tab and session read when selecting its project synchronously admits a successor', async () => {
    const store = createTeamNavigationStore();
    const response = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);
    const pending = store.getState().fetchRepositoryGroups();
    store.getState().openTeamTab('old-team', '/TEST/old-project');
    const unsubscribe = store.subscribe((state) => {
      if (state.selectedProjectId !== 'old-project-worktree') return;
      unsubscribe();
      state.openTeamTab('new-team', '/TEST/new-project');
    });
    response.resolve([
      repositoryGroup('old-project', '/TEST/old-project'),
      repositoryGroup('new-project', '/TEST/new-project'),
    ]);
    await pending;

    expect(store.getState().selectedProjectId).toBe('new-project-worktree');
    expect(store.getState().fetchSessionsInitial).toHaveBeenCalledExactlyOnceWith(
      'new-project-worktree'
    );
    expect(store.getState().getAllPaneTabs()).toHaveLength(1);
    expect(store.getState().getAllPaneTabs()[0]).toMatchObject({
      type: 'team',
      teamName: 'new-team',
    });
  });

  it('cancels a pending project intent when the same source tab receives a newer no-path navigation', async () => {
    const store = createTeamNavigationStore();
    store.getState().openTeamTab('builders');
    const originalTabId = store.getState().activeTabId;
    const response = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);
    const pending = store.getState().fetchRepositoryGroups();
    store.getState().openTeamTab('old-team', '/TEST/old-project');
    store.getState().openTeamTab('builders');
    response.resolve([repositoryGroup('old-project', '/TEST/old-project')]);
    await pending;

    expect(store.getState().activeTabId).toBe(originalTabId);
    expect(store.getState().selectedProjectId).toBeNull();
    expect(store.getState().getAllPaneTabs()).toHaveLength(1);
    expect(store.getState().fetchSessionsInitial).not.toHaveBeenCalled();
  });

  it('refuses the old session read when a delayed flat selection synchronously admits a successor', async () => {
    const store = createTeamNavigationStore();
    const response = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);
    const pending = store.getState().fetchRepositoryGroups();
    store.getState().openTeamTab('old-team', '/TEST/old-project');
    apiMock.getProjects.mockResolvedValueOnce([
      project('old-project', '/TEST/old-project'),
      project('new-project', '/TEST/new-project'),
    ]);
    await store.getState().fetchProjects();
    const unsubscribe = store.subscribe((state) => {
      if (state.selectedProjectId !== 'old-project') return;
      unsubscribe();
      state.openTeamTab('new-team', '/TEST/new-project');
    });
    response.resolve([]);
    await pending;

    expect(store.getState().selectedProjectId).toBe('new-project');
    expect(store.getState().fetchSessionsInitial).toHaveBeenCalledExactlyOnceWith('new-project');
    expect(store.getState().getAllPaneTabs()).toHaveLength(1);
    expect(store.getState().getAllPaneTabs()[0]).toMatchObject({
      type: 'team',
      teamName: 'new-team',
    });
  });

  it('selects the complete flat project tuple before exposing a delayed logical tab', async () => {
    const store = createTeamNavigationStore();
    store.setState({
      selectedProjectId: 'project-b',
      activeProjectId: 'old-project',
      selectedRepositoryId: 'old-repository',
      selectedWorktreeId: 'old-worktree',
    });
    const response = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);
    const pending = store.getState().fetchRepositoryGroups();
    store.getState().openTeamTab('builders', '/TEST/project-b');
    apiMock.getProjects.mockResolvedValueOnce([project('project-b', '/TEST/project-b')]);
    await store.getState().fetchProjects();
    response.resolve([]);
    await pending;

    expect(store.getState()).toMatchObject({
      selectedRepositoryId: null,
      selectedWorktreeId: null,
      selectedProjectId: 'project-b',
      activeProjectId: 'project-b',
    });
    expect(store.getState().fetchSessionsInitial).toHaveBeenCalledExactlyOnceWith('project-b');
    expect(store.getState().getAllPaneTabs()).toHaveLength(1);
    expect(store.getState().getAllPaneTabs()[0]).toMatchObject({
      type: 'team',
      teamName: 'builders',
    });
  });

  it('keeps navigation ownership independent between two stores', async () => {
    const first = createTeamNavigationStore(),
      second = createTeamNavigationStore();
    const firstResponse = deferred<RepositoryGroup[]>(),
      secondResponse = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const firstPending = first.getState().fetchRepositoryGroups();
    const secondPending = second.getState().fetchRepositoryGroups();
    first.getState().openTeamTab('first-team', '/TEST/first');
    second.getState().openTeamTab('second-team', '/TEST/second');
    firstResponse.resolve([repositoryGroup('first', '/TEST/first')]);
    secondResponse.resolve([repositoryGroup('second', '/TEST/second')]);
    await Promise.all([firstPending, secondPending]);

    expect(first.getState().selectedProjectId).toBe('first-worktree');
    expect(second.getState().selectedProjectId).toBe('second-worktree');
    expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(2);
  });

  it('retires the continuation when the original catalog timeout publishes an error', async () => {
    vi.useFakeTimers();
    const store = createTeamNavigationStore();
    const response = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);
    const pending = store.getState().fetchRepositoryGroups();
    store.getState().openTeamTab('builders', '/TEST/project-b');
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;

    expect(store.getState().repositoryGroupsError).toBe(
      'get-repository-groups timed out after 30000ms'
    );
    expect(store.getState().selectedProjectId).toBeNull();
    response.resolve([repositoryGroup('project-b', '/TEST/project-b')]);
    store.setState({
      repositoryGroups: [repositoryGroup('project-b', '/TEST/project-b')],
      repositoryGroupsInitialized: true,
      repositoryGroupsError: null,
    });
    await Promise.resolve();
    expect(store.getState().selectedProjectId).toBeNull();
    expect(store.getState().fetchSessionsInitial).not.toHaveBeenCalled();
    expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(1);
  });

  it('retires a successful catalog with no matching path instead of selecting another worktree', async () => {
    const store = createTeamNavigationStore();
    const response = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(response.promise);
    const pending = store.getState().fetchRepositoryGroups();
    store.getState().openTeamTab('builders', '/TEST/project-b');
    response.resolve([repositoryGroup('other', '/TEST/other')]);
    await pending;
    store.setState({ repositoryGroups: [repositoryGroup('project-b', '/TEST/project-b')] });

    expect(store.getState().selectedProjectId).toBeNull();
    expect(store.getState().fetchSessionsInitial).not.toHaveBeenCalled();
    expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(1);
  });
});
