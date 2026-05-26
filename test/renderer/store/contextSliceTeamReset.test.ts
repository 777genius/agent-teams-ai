import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

import { createTestStore } from './storeTestUtils';

const apiMock = vi.hoisted(() => ({
  context: {
    switch: vi.fn(async () => undefined),
    list: vi.fn(async () => [{ id: 'local', type: 'local' }]),
    getActive: vi.fn(async () => 'local'),
    onChanged: vi.fn(() => () => undefined),
  },
  getProjects: vi.fn(async (): Promise<unknown[]> => []),
  getRepositoryGroups: vi.fn(async (): Promise<unknown[]> => []),
  notifications: {
    get: vi.fn(async () => ({
      notifications: [],
      total: 0,
      totalCount: 0,
      unreadCount: 0,
      hasMore: false,
    })),
  },
  teams: {
    list: vi.fn(async () => []),
    getAllTasks: vi.fn(async () => []),
    showMessageNotification: vi.fn(async () => undefined),
  },
  ssh: {
    connect: vi.fn(async () => ({ state: 'connected', host: 'dev', error: null })),
    disconnect: vi.fn(async () => ({ state: 'disconnected', host: null, error: null })),
    saveLastConnection: vi.fn(async () => undefined),
  },
}));

const contextStorageMock = vi.hoisted(() => ({
  saveSnapshot: vi.fn(async () => undefined),
  loadSnapshot: vi.fn(),
  cleanupExpired: vi.fn(async () => undefined),
  isAvailable: vi.fn(async () => true),
}));

const draftStorageMock = vi.hoisted(() => ({
  cleanupExpired: vi.fn(async () => undefined),
}));

vi.mock('@renderer/api', () => ({
  api: apiMock,
}));

vi.mock('@renderer/services/contextStorage', () => ({
  contextStorage: contextStorageMock,
}));

vi.mock('@renderer/services/draftStorage', () => ({
  draftStorage: draftStorageMock,
}));

function targetSnapshot() {
  return {
    projects: [
      {
        id: 'ssh-project',
        name: 'SSH Project',
        path: '/ssh/project',
        sessions: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ],
    selectedProjectId: null,
    repositoryGroups: [],
    selectedRepositoryId: null,
    selectedWorktreeId: null,
    viewMode: 'flat' as const,
    sessions: [],
    selectedSessionId: null,
    sessionsCursor: null,
    sessionsHasMore: false,
    sessionsTotalCount: 0,
    pinnedSessionIds: [],
    notifications: [],
    unreadCount: 0,
    openTabs: [],
    activeTabId: null,
    selectedTabIds: [],
    activeProjectId: null,
    paneLayout: {
      panes: [
        {
          id: 'pane-default',
          tabs: [],
          activeTabId: null,
          selectedTabIds: [],
          widthFraction: 1,
        },
      ],
      focusedPaneId: 'pane-default',
    },
    sidebarCollapsed: false,
    _metadata: {
      contextId: 'ssh-dev',
      capturedAt: Date.now(),
      version: 1,
    },
  };
}

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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('context slice team/task reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContextScopedRequestEpochForTests();
    contextStorageMock.loadSnapshot.mockResolvedValue(targetSnapshot());
    apiMock.context.getActive.mockResolvedValue('local');
    apiMock.getProjects.mockResolvedValue(targetSnapshot().projects);
    apiMock.getRepositoryGroups.mockResolvedValue([]);
    apiMock.teams.list.mockResolvedValue([]);
    apiMock.teams.getAllTasks.mockResolvedValue([]);
  });

  afterEach(() => {
    resetContextScopedRequestEpochForTests();
    vi.restoreAllMocks();
  });

  it('does not refetch context-scoped data when lazy initialization keeps the same context', async () => {
    const store = createTestStore();
    store.setState({
      activeContextId: 'local',
      projects: [
        {
          id: 'local-project',
          name: 'Local Project',
          path: '/local/project',
          sessions: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ],
      projectsInitialized: true,
      repositoryGroups: [
        {
          id: 'local-repo',
          identity: null,
          name: 'Local Repo',
          totalSessions: 0,
          worktrees: [],
        },
      ],
      repositoryGroupsInitialized: true,
      teams: [
        {
          teamName: 'local-team',
          displayName: 'Local Team',
          projectPath: '/local/project',
        },
      ],
      globalTasks: [
        {
          id: 'local-task',
          subject: 'Local task',
          status: 'todo',
          teamName: 'local-team',
          teamDisplayName: 'Local Team',
          projectPath: '/local/project',
          comments: [],
        },
      ],
      globalTasksInitialized: true,
    } as never);

    await store.getState().initializeContextSystem();

    expect(store.getState().activeContextId).toBe('local');
    expect(store.getState().projectsInitialized).toBe(true);
    expect(store.getState().repositoryGroupsInitialized).toBe(true);
    expect(apiMock.context.list).toHaveBeenCalledTimes(1);
    expect(apiMock.getProjects).not.toHaveBeenCalled();
    expect(apiMock.getRepositoryGroups).not.toHaveBeenCalled();
    expect(apiMock.teams.list).not.toHaveBeenCalled();
    expect(apiMock.teams.getAllTasks).not.toHaveBeenCalled();
  });

  it('drops previous-context team and task caches before refreshing the target context', async () => {
    const store = createTestStore();
    store.setState({
      activeContextId: 'local',
      teams: [
        {
          teamName: 'local-team',
          displayName: 'Local Team',
          projectPath: '/local/project',
        },
      ],
      teamByName: {
        'local-team': {
          teamName: 'local-team',
          displayName: 'Local Team',
          projectPath: '/local/project',
        },
      },
      teamBySessionId: {},
      globalTasks: [
        {
          id: 'local-task',
          subject: 'Local task',
          status: 'todo',
          teamName: 'local-team',
          teamDisplayName: 'Local Team',
          projectPath: '/local/project',
          comments: [],
        },
      ],
      globalTasksInitialized: true,
      selectedTeamName: 'local-team',
      selectedTeamData: { teamName: 'local-team' },
      teamDataCacheByName: { 'local-team': { teamName: 'local-team' } },
    } as never);

    await store.getState().switchContext('ssh-dev');

    expect(store.getState().activeContextId).toBe('ssh-dev');
    expect(store.getState().teams).toEqual([]);
    expect(store.getState().teamByName).toEqual({});
    expect(store.getState().globalTasks).toEqual([]);
    expect(store.getState().selectedTeamName).toBeNull();
    expect(store.getState().selectedTeamData).toBeNull();
    expect(store.getState().teamDataCacheByName).toEqual({});
    expect(apiMock.teams.list).toHaveBeenCalledTimes(1);
    expect(apiMock.teams.getAllTasks).toHaveBeenCalledTimes(1);
  });

  it('updates the active context before slow first-visit project scans can trigger team refreshes', async () => {
    contextStorageMock.loadSnapshot.mockResolvedValue(null);
    const projectScan = deferred<unknown[]>();
    apiMock.getProjects.mockReturnValue(projectScan.promise);
    apiMock.getRepositoryGroups.mockResolvedValue([]);
    const store = createTestStore();
    store.setState({
      activeContextId: 'local',
      teams: [
        {
          teamName: 'local-team',
          displayName: 'Local Team',
          projectPath: '/local/project',
        },
      ],
      globalTasks: [
        {
          id: 'local-task',
          subject: 'Local task',
          status: 'todo',
          teamName: 'local-team',
          teamDisplayName: 'Local Team',
          projectPath: '/local/project',
          comments: [],
        },
      ],
      globalTasksInitialized: true,
    } as never);

    const switchPromise = store.getState().switchContext('ssh-dev');
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().activeContextId).toBe('ssh-dev');
    expect(store.getState().isContextSwitching).toBe(true);
    expect(store.getState().teams).toEqual([]);
    expect(store.getState().globalTasks).toEqual([]);

    projectScan.resolve(targetSnapshot().projects);
    await switchPromise;

    expect(store.getState().activeContextId).toBe('ssh-dev');
    expect(store.getState().isContextSwitching).toBe(false);
  });

  it('does not apply a slow background project refresh after the context epoch changes again', async () => {
    const projectScan = deferred<unknown[]>();
    apiMock.getProjects.mockReturnValue(projectScan.promise);
    apiMock.getRepositoryGroups.mockResolvedValue([]);
    const store = createTestStore();
    const localProject = {
      id: 'local-project',
      name: 'Local Project',
      path: '/local/project',
      sessions: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    const switchPromise = store.getState().switchContext('ssh-dev');
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().activeContextId).toBe('ssh-dev');
    expect(store.getState().isContextSwitching).toBe(false);

    invalidateContextScopedRequestEpoch();
    store.setState({
      activeContextId: 'local',
      projects: [localProject],
      repositoryGroups: [],
      isContextSwitching: false,
      targetContextId: null,
    } as never);
    projectScan.resolve([
      {
        id: 'late-ssh-project',
        name: 'Late SSH Project',
        path: '/ssh/late',
        sessions: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ]);
    await switchPromise;

    expect(store.getState().activeContextId).toBe('local');
    expect(store.getState().projects).toEqual([localProject]);
    expect(apiMock.teams.list).not.toHaveBeenCalled();
    expect(apiMock.teams.getAllTasks).not.toHaveBeenCalled();
  });

  it('drops previous-context team and task caches when lazy context initialization changes context', async () => {
    apiMock.context.getActive.mockResolvedValue('ssh-dev');
    const store = createTestStore();
    store.setState({
      activeContextId: 'local',
      projects: [
        {
          id: 'local-project',
          name: 'Local Project',
          path: '/local/project',
          sessions: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ],
      projectsInitialized: true,
      repositoryGroups: [
        {
          id: 'local-repo',
          identity: null,
          name: 'Local Repo',
          totalSessions: 0,
          worktrees: [],
        },
      ],
      repositoryGroupsInitialized: true,
      teams: [
        {
          teamName: 'local-team',
          displayName: 'Local Team',
          projectPath: '/local/project',
        },
      ],
      teamByName: {
        'local-team': {
          teamName: 'local-team',
          displayName: 'Local Team',
          projectPath: '/local/project',
        },
      },
      globalTasks: [
        {
          id: 'local-task',
          subject: 'Local task',
          status: 'todo',
          teamName: 'local-team',
          teamDisplayName: 'Local Team',
          projectPath: '/local/project',
          comments: [],
        },
      ],
      globalTasksInitialized: true,
    } as never);

    await store.getState().initializeContextSystem();

    expect(store.getState().activeContextId).toBe('ssh-dev');
    expect(store.getState().projects).toEqual(targetSnapshot().projects);
    expect(store.getState().projectsInitialized).toBe(true);
    expect(store.getState().repositoryGroups).toEqual([]);
    expect(store.getState().repositoryGroupsInitialized).toBe(true);
    expect(store.getState().teams).toEqual([]);
    expect(store.getState().teamByName).toEqual({});
    expect(store.getState().globalTasks).toEqual([]);
    expect(apiMock.getProjects).toHaveBeenCalledTimes(1);
    expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(1);
    expect(apiMock.teams.list).toHaveBeenCalledTimes(1);
    expect(apiMock.teams.getAllTasks).toHaveBeenCalledTimes(1);
  });

  it('clears project and repository loading guards before lazy context initialization refetches', async () => {
    apiMock.context.getActive.mockResolvedValue('ssh-dev');
    const projectScan = deferred<unknown[]>();
    const repositoryScan = deferred<unknown[]>();
    apiMock.getProjects.mockReturnValue(projectScan.promise);
    apiMock.getRepositoryGroups.mockReturnValue(repositoryScan.promise);
    const store = createTestStore();
    store.setState({
      activeContextId: 'local',
      projectsLoading: true,
      repositoryGroupsLoading: true,
    } as never);

    await store.getState().initializeContextSystem();

    expect(apiMock.getProjects).toHaveBeenCalledTimes(1);
    expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(1);
    expect(store.getState().projectsLoading).toBe(true);
    expect(store.getState().repositoryGroupsLoading).toBe(true);

    projectScan.resolve([]);
    repositoryScan.resolve([]);
    await Promise.all([projectScan.promise, repositoryScan.promise]);
    await flushMicrotasks();

    expect(store.getState().projectsLoading).toBe(false);
    expect(store.getState().repositoryGroupsLoading).toBe(false);
  });

  it('drops previous-context team and task caches on direct SSH connect', async () => {
    const store = createTestStore();
    store.setState({
      activeContextId: 'local',
      teams: [
        {
          teamName: 'local-team',
          displayName: 'Local Team',
          projectPath: '/local/project',
        },
      ],
      teamByName: {
        'local-team': {
          teamName: 'local-team',
          displayName: 'Local Team',
          projectPath: '/local/project',
        },
      },
      globalTasks: [
        {
          id: 'local-task',
          subject: 'Local task',
          status: 'todo',
          teamName: 'local-team',
          teamDisplayName: 'Local Team',
          projectPath: '/local/project',
          comments: [],
        },
      ],
      globalTasksInitialized: true,
      isContextSwitching: true,
      targetContextId: 'local',
    } as never);

    await store.getState().connectSsh({
      host: 'dev',
      port: 22,
      username: 'me',
      authMethod: 'privateKey',
      privateKeyPath: '/tmp/key',
    });

    expect(store.getState().activeContextId).toBe('ssh-dev');
    expect(store.getState().teams).toEqual([]);
    expect(store.getState().teamByName).toEqual({});
    expect(store.getState().globalTasks).toEqual([]);
    expect(store.getState().isContextSwitching).toBe(false);
    expect(store.getState().targetContextId).toBeNull();
    expect(apiMock.teams.list).toHaveBeenCalledTimes(1);
    expect(apiMock.teams.getAllTasks).toHaveBeenCalledTimes(1);
  });

  it('clears project and repository loading guards before direct SSH connect refetches', async () => {
    const projectScan = deferred<unknown[]>();
    const repositoryScan = deferred<unknown[]>();
    apiMock.getProjects.mockReturnValue(projectScan.promise);
    apiMock.getRepositoryGroups.mockReturnValue(repositoryScan.promise);
    const store = createTestStore();
    store.setState({
      activeContextId: 'local',
      projectsLoading: true,
      repositoryGroupsLoading: true,
    } as never);

    await store.getState().connectSsh({
      host: 'dev',
      port: 22,
      username: 'me',
      authMethod: 'privateKey',
      privateKeyPath: '/tmp/key',
    });

    expect(apiMock.getProjects).toHaveBeenCalledTimes(1);
    expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(1);
    expect(store.getState().projectsLoading).toBe(true);
    expect(store.getState().repositoryGroupsLoading).toBe(true);

    projectScan.resolve([]);
    repositoryScan.resolve([]);
    await Promise.all([projectScan.promise, repositoryScan.promise]);
    await flushMicrotasks();

    expect(store.getState().projectsLoading).toBe(false);
    expect(store.getState().repositoryGroupsLoading).toBe(false);
  });

  it('drops previous-context team and task caches on direct SSH disconnect', async () => {
    const store = createTestStore();
    store.setState({
      activeContextId: 'ssh-dev',
      teams: [
        {
          teamName: 'ssh-team',
          displayName: 'SSH Team',
          projectPath: '/ssh/project',
        },
      ],
      teamByName: {
        'ssh-team': {
          teamName: 'ssh-team',
          displayName: 'SSH Team',
          projectPath: '/ssh/project',
        },
      },
      globalTasks: [
        {
          id: 'ssh-task',
          subject: 'SSH task',
          status: 'todo',
          teamName: 'ssh-team',
          teamDisplayName: 'SSH Team',
          projectPath: '/ssh/project',
          comments: [],
        },
      ],
      globalTasksInitialized: true,
      isContextSwitching: true,
      targetContextId: 'local',
    } as never);

    await store.getState().disconnectSsh();

    expect(store.getState().activeContextId).toBe('local');
    expect(store.getState().teams).toEqual([]);
    expect(store.getState().teamByName).toEqual({});
    expect(store.getState().globalTasks).toEqual([]);
    expect(store.getState().isContextSwitching).toBe(false);
    expect(store.getState().targetContextId).toBeNull();
    expect(apiMock.teams.list).toHaveBeenCalledTimes(1);
    expect(apiMock.teams.getAllTasks).toHaveBeenCalledTimes(1);
  });

  it('clears project and repository loading guards before direct SSH disconnect refetches', async () => {
    const projectScan = deferred<unknown[]>();
    const repositoryScan = deferred<unknown[]>();
    apiMock.getProjects.mockReturnValue(projectScan.promise);
    apiMock.getRepositoryGroups.mockReturnValue(repositoryScan.promise);
    const store = createTestStore();
    store.setState({
      activeContextId: 'ssh-dev',
      projectsLoading: true,
      repositoryGroupsLoading: true,
    } as never);

    await store.getState().disconnectSsh();

    expect(apiMock.getProjects).toHaveBeenCalledTimes(1);
    expect(apiMock.getRepositoryGroups).toHaveBeenCalledTimes(1);
    expect(store.getState().projectsLoading).toBe(true);
    expect(store.getState().repositoryGroupsLoading).toBe(true);

    projectScan.resolve([]);
    repositoryScan.resolve([]);
    await Promise.all([projectScan.promise, repositoryScan.promise]);
    await flushMicrotasks();

    expect(store.getState().projectsLoading).toBe(false);
    expect(store.getState().repositoryGroupsLoading).toBe(false);
  });
});
