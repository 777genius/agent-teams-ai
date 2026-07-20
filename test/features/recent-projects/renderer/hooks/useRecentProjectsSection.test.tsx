import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useRecentProjectsSection } from '@features/recent-projects/renderer/hooks/useRecentProjectsSection';
import {
  __resetRecentProjectsClientCacheForTests,
  loadRecentProjectsWithClientCache,
} from '@features/recent-projects/renderer/utils/recentProjectsClientCache';
import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DashboardRecentProject,
  DashboardRecentProjectsPayload,
} from '@features/recent-projects/contracts';
import type { TeamSummary } from '@shared/types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const apiMock = vi.hoisted(() => ({
  getDashboardRecentProjects: vi.fn(),
  teams: {
    aliveList: vi.fn(),
  },
  config: {
    addCustomProjectPath: vi.fn(),
    selectFolders: vi.fn(),
  },
  openPath: vi.fn(),
}));

const storeState = vi.hoisted(() => ({
  globalTasks: [],
  globalTasksInitialized: false,
  globalTasksLoading: false,
  fetchAllTasks: vi.fn(),
  teams: [] as TeamSummary[],
  activeContextId: 'local',
  provisioningRuns: {},
  currentProvisioningRunIdByTeam: {},
  provisioningSnapshotByTeam: {},
  repositoryGroups: [],
  fetchRepositoryGroups: vi.fn(),
  openTeamsTab: vi.fn(),
  fetchSessionsInitial: vi.fn(),
  selectedRepositoryId: null as string | null,
  selectedWorktreeId: null as string | null,
  selectedProjectId: null as string | null,
  activeProjectId: null as string | null,
}));

vi.mock('@renderer/api', () => ({
  api: apiMock,
  isElectronMode: () => true,
}));

vi.mock('@renderer/store', () => {
  const useStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    {
      getState: () => storeState,
      setState: vi.fn(
        (
          patch:
            | Partial<typeof storeState>
            | ((state: typeof storeState) => Partial<typeof storeState>)
        ) => {
          Object.assign(storeState, typeof patch === 'function' ? patch(storeState) : patch);
        }
      ),
    }
  );
  return { useStore };
});

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function project(id: string, projectPath = `/tmp/${id}`): DashboardRecentProject {
  return {
    id,
    name: id,
    primaryPath: projectPath,
    associatedPaths: [projectPath],
    mostRecentActivity: Date.parse('2026-04-14T12:00:00.000Z'),
    providerIds: ['anthropic'],
    source: 'claude',
    openTarget: {
      type: 'synthetic-path',
      path: projectPath,
    },
  };
}

function payload(id: string, projectPath?: string): DashboardRecentProjectsPayload {
  return {
    projects: [project(id, projectPath)],
    degraded: false,
  };
}

function team(teamName: string, projectPath: string): TeamSummary {
  return {
    teamName,
    displayName: teamName,
    description: '',
    memberCount: 1,
    taskCount: 0,
    lastActivity: null,
    projectPath,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useRecentProjectsSection', () => {
  let host: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useRecentProjectsSection> | null;

  function Harness(): React.JSX.Element | null {
    latest = useRecentProjectsSection('', 20);
    return null;
  }

  async function renderHarness(): Promise<void> {
    await act(async () => {
      root.render(React.createElement(Harness));
      await flushPromises();
    });
  }

  beforeEach(() => {
    __resetRecentProjectsClientCacheForTests();
    resetContextScopedRequestEpochForTests();
    vi.clearAllMocks();
    latest = null;
    storeState.globalTasks = [];
    storeState.globalTasksInitialized = false;
    storeState.globalTasksLoading = false;
    storeState.teams = [];
    storeState.activeContextId = 'local';
    storeState.provisioningRuns = {};
    storeState.currentProvisioningRunIdByTeam = {};
    storeState.provisioningSnapshotByTeam = {};
    storeState.repositoryGroups = [];
    storeState.selectedRepositoryId = null;
    storeState.selectedWorktreeId = null;
    storeState.selectedProjectId = null;
    storeState.activeProjectId = null;
    apiMock.teams.aliveList.mockResolvedValue([]);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    __resetRecentProjectsClientCacheForTests();
    resetContextScopedRequestEpochForTests();
  });

  it('ignores stale recent-project loads after the context epoch changes back to the same id', async () => {
    const oldLocalRequest = deferred<DashboardRecentProjectsPayload>();
    const sshRequest = deferred<DashboardRecentProjectsPayload>();
    const freshLocalRequest = deferred<DashboardRecentProjectsPayload>();

    apiMock.getDashboardRecentProjects
      .mockReturnValueOnce(oldLocalRequest.promise)
      .mockReturnValueOnce(sshRequest.promise)
      .mockReturnValueOnce(freshLocalRequest.promise);

    await renderHarness();
    expect(apiMock.getDashboardRecentProjects).toHaveBeenCalledTimes(1);

    invalidateContextScopedRequestEpoch();
    storeState.activeContextId = 'ssh-dev';
    await renderHarness();
    expect(apiMock.getDashboardRecentProjects).toHaveBeenCalledTimes(2);

    invalidateContextScopedRequestEpoch();
    storeState.activeContextId = 'local';
    await renderHarness();
    expect(apiMock.getDashboardRecentProjects).toHaveBeenCalledTimes(3);

    await act(async () => {
      oldLocalRequest.resolve(payload('old-local'));
      await oldLocalRequest.promise;
      await flushPromises();
    });

    expect(latest?.cards.map((card) => card.name)).toEqual([]);
    expect(latest?.loading).toBe(true);

    await act(async () => {
      freshLocalRequest.resolve(payload('fresh-local'));
      await freshLocalRequest.promise;
      await flushPromises();
    });

    expect(latest?.cards.map((card) => card.name)).toEqual(['fresh-local']);
    expect(latest?.loading).toBe(false);
  });

  it('cancels stale alive-list responses when only the active context changes', async () => {
    const oldAliveRequest = deferred<string[]>();
    const sshAliveRequest = deferred<string[]>();
    const freshAliveRequest = deferred<string[]>();

    await loadRecentProjectsWithClientCache('local', () => Promise.resolve(payload('alpha')), {
      force: true,
    });

    apiMock.getDashboardRecentProjects.mockResolvedValue(payload('alpha'));
    apiMock.teams.aliveList
      .mockReturnValueOnce(oldAliveRequest.promise)
      .mockReturnValueOnce(sshAliveRequest.promise)
      .mockReturnValueOnce(freshAliveRequest.promise);
    storeState.teams = [team('old-team', '/tmp/alpha'), team('fresh-team', '/tmp/alpha')];

    await renderHarness();
    expect(apiMock.teams.aliveList).toHaveBeenCalledTimes(1);

    invalidateContextScopedRequestEpoch();
    storeState.activeContextId = 'ssh-dev';
    await renderHarness();
    expect(apiMock.teams.aliveList).toHaveBeenCalledTimes(2);

    invalidateContextScopedRequestEpoch();
    storeState.activeContextId = 'local';
    await renderHarness();
    expect(apiMock.teams.aliveList).toHaveBeenCalledTimes(3);

    await act(async () => {
      freshAliveRequest.resolve(['fresh-team']);
      await freshAliveRequest.promise;
      await flushPromises();
    });

    expect(latest?.cards[0]?.activeTeams?.map((activeTeam) => activeTeam.teamName)).toEqual([
      'fresh-team',
    ]);

    await act(async () => {
      oldAliveRequest.resolve(['old-team']);
      await oldAliveRequest.promise;
      await flushPromises();
    });

    expect(latest?.cards[0]?.activeTeams?.map((activeTeam) => activeTeam.teamName)).toEqual([
      'fresh-team',
    ]);
  });

  it('passes an existing-worktree project path to Teams before repository groups load', async () => {
    const selectedProject = {
      ...project('alpha', '/tmp/alpha'),
      openTarget: {
        type: 'existing-worktree' as const,
        repositoryId: 'repo-alpha',
        worktreeId: 'worktree-alpha',
      },
    };
    apiMock.getDashboardRecentProjects.mockResolvedValue({
      projects: [selectedProject],
      degraded: false,
    });

    await renderHarness();

    await act(async () => {
      await latest?.openRecentProject(selectedProject);
      await flushPromises();
    });

    expect(storeState.repositoryGroups).toEqual([]);
    expect(storeState).toEqual(
      expect.objectContaining({
        selectedRepositoryId: 'repo-alpha',
        selectedWorktreeId: 'worktree-alpha',
        selectedProjectId: 'worktree-alpha',
        activeProjectId: 'worktree-alpha',
      })
    );
    expect(storeState.fetchSessionsInitial).toHaveBeenCalledWith('worktree-alpha');
    expect(storeState.openTeamsTab).toHaveBeenCalledOnce();
    expect(storeState.openTeamsTab).toHaveBeenCalledWith('/tmp/alpha');
  });
});
