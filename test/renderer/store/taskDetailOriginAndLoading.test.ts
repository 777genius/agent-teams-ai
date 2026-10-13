import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import {
  __resetTeamSliceModuleStateForTests,
  createTeamSlice,
} from '../../../src/renderer/store/slices/teamSlice';
import { createTeamTaskDetailSlice } from '../../../src/renderer/store/slices/teamTaskDetailSlice';

import type { AppState } from '../../../src/renderer/store/types';

const apiMock = vi.hoisted(() => ({
  teams: {
    list: vi.fn(),
    getAllTasks: vi.fn(),
    getData: vi.fn(),
    getTask: vi.fn(),
    getMessagesPage: vi.fn(),
    getMemberActivityMeta: vi.fn(),
    getMemberSpawnStatuses: vi.fn(),
    getTeamAgentRuntime: vi.fn(),
    getTaskChangePresence: vi.fn(),
    showMessageNotification: vi.fn(async () => undefined),
  },
  review: {
    invalidateTaskChangeSummaries: vi.fn(async () => undefined),
  },
  crossTeam: {
    listTargets: vi.fn(),
  },
}));

vi.mock('@renderer/api', () => ({ api: apiMock }));

function snapshot(projectPath: string, taskId = 'X') {
  return {
    teamName: 'shared-team',
    config: { name: 'shared-team', projectPath },
    tasks: [{ id: taskId, changePresence: 'clean' }],
    members: [],
    kanbanState: { teamName: 'shared-team', reviewers: [], tasks: {} },
    processes: [],
  };
}

function createStore() {
  return create<AppState>()((set, get, store) => ({
    ...createTeamSlice(set as never, get as never, store as never),
    ...createTeamTaskDetailSlice(set as never, get as never, store as never),
    activeContextId: 'local',
    appConfig: null,
    paneLayout: {
      focusedPaneId: 'pane-default',
      panes: [{ id: 'pane-default', widthFraction: 1, tabs: [], activeTabId: null }],
    },
    openTab: vi.fn(),
    setActiveTab: vi.fn(),
    updateTabLabel: vi.fn(),
    getAllPaneTabs: vi.fn(() => []),
    warmTaskChangeSummaries: vi.fn(async () => undefined),
    invalidateTaskChangePresence: vi.fn(),
    projects: [],
    repositoryGroups: [],
    selectedProjectId: null,
    selectedWorktreeId: null,
    fetchSessionsInitial: vi.fn(async () => undefined),
  }) as unknown as AppState);
}

describe('task detail origin and loading postconditions', () => {
  beforeEach(() => {
    __resetTeamSliceModuleStateForTests();
    vi.clearAllMocks();
  });

  it('rejects A/B/A stale identities before refresh or getTask side effects', async () => {
    const store = createStore();
    apiMock.teams.getData.mockResolvedValue(snapshot('/local'));
    apiMock.teams.getTask.mockResolvedValue({
      id: 'X',
      subject: 'X',
      status: 'in_progress',
    });

    store.setState({ activeContextId: 'A' });
    const stale = store.getState().ensureTaskDetail({
      contextId: 'A',
      teamName: 'shared-team',
      taskId: 'X',
    });
    store.setState({ activeContextId: 'B' });
    await stale;
    expect(apiMock.teams.getData).not.toHaveBeenCalled();
    expect(apiMock.teams.getTask).not.toHaveBeenCalled();
    expect(store.getState().taskDetailById).toEqual({});

    const staleAfterRefresh = store.getState().ensureTaskDetail({
      contextId: 'A',
      teamName: 'shared-team',
      taskId: 'X',
    });
    store.setState({ activeContextId: 'B' });
    await staleAfterRefresh;
    expect(apiMock.teams.getData).not.toHaveBeenCalled();
    expect(apiMock.teams.getTask).not.toHaveBeenCalled();
  });

  it('finishes loading when refreshed data is structurally identical', async () => {
    const store = createStore();
    apiMock.teams.getData.mockResolvedValue(snapshot('/same'));
    await store.getState().selectTeam('shared-team');
    const before = store.getState().selectedTeamData;
    store.setState({ selectedTeamLoading: true, selectedTeamData: before });

    await store.getState().refreshTeamData('shared-team', { withDedup: true });

    expect(store.getState().selectedTeamData).toBe(before);
    expect(store.getState().selectedTeamLoading).toBe(false);
    expect(store.getState().selectedTeamError).toBeNull();
  });
});
