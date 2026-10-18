import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import {
  __resetTeamSliceModuleStateForTests,
  createTeamSlice,
} from '../../../src/renderer/store/slices/teamSlice';
import {
  resetSelectTeamLoadLatchForTests,
  SELECT_TEAM_STALE_RETRY_BASE_DELAY_MS,
  SELECT_TEAM_STALE_RETRY_LIMIT,
} from '../../../src/renderer/store/team/selectTeamLoadLatch';
import {
  clearAllTeamLocalStateEpochs,
  invalidateTeamLocalStateEpoch,
} from '../../../src/renderer/store/team/teamLocalStateEpoch';

import type { TeamSlice } from '../../../src/renderer/store/slices/teamSlice';
import type { AppState } from '../../../src/renderer/store/types';
import type { TeamViewSnapshot } from '../../../src/shared/types';

const apiMock = vi.hoisted(() => ({
  teams: {
    list: vi.fn(),
    getAllTasks: vi.fn(),
    getData: vi.fn(),
    getTask: vi.fn(),
    getTaskActivity: vi.fn(),
    getMessagesPage: vi.fn(),
    getMemberActivityMeta: vi.fn(),
    getMemberSpawnStatuses: vi.fn(),
    getTeamAgentRuntime: vi.fn(),
    getTaskChangePresence: vi.fn(),
    getDeletedTasks: vi.fn(),
    updateToolApprovalSettings: vi.fn(async () => undefined),
    showMessageNotification: vi.fn(async () => undefined),
    onProvisioningProgress: vi.fn(() => () => undefined),
  },
  review: {
    invalidateTaskChangeSummaries: vi.fn(async () => undefined),
  },
  crossTeam: {
    listTargets: vi.fn(),
  },
}));

vi.mock('@renderer/api', () => ({ api: apiMock }));
vi.mock('@renderer/services/composerDraftRepository', () => ({
  composerDraftRepository: {
    discardNamespace: vi.fn(async () => undefined),
  },
}));

type HarnessState = TeamSlice &
  Pick<
    AppState,
    | 'activeContextId'
    | 'getAllPaneTabs'
    | 'invalidateTaskChangePresence'
    | 'openTab'
    | 'paneLayout'
    | 'selectedProjectId'
    | 'setActiveTab'
    | 'updateTabLabel'
    | 'warmTaskChangeSummaries'
  >;

function createHarnessStore() {
  return create<HarnessState>()((set, get, store) => ({
    ...createTeamSlice(set as never, get as never, store as never),
    activeContextId: 'local',
    paneLayout: {
      focusedPaneId: 'pane-default',
      panes: [
        {
          id: 'pane-default',
          widthFraction: 1,
          tabs: [],
          activeTabId: null,
          selectedTabIds: [],
        },
      ],
    } as AppState['paneLayout'],
    selectedProjectId: null,
    openTab: vi.fn(),
    setActiveTab: vi.fn(),
    updateTabLabel: vi.fn(),
    getAllPaneTabs: vi.fn(() => []),
    warmTaskChangeSummaries: vi.fn(async () => undefined),
    invalidateTaskChangePresence: vi.fn(),
    fetchTeams: vi.fn(async () => undefined),
    fetchAllTasks: vi.fn(async () => undefined),
  }));
}

const TEAM = 'stale-team';

function snapshotFor(teamName: string): TeamViewSnapshot {
  return {
    teamName,
    config: { name: teamName, projectPath: '/TEST/project' },
    tasks: [{ id: 'X', subject: 'X', status: 'in_progress', changePresence: 'no_changes' }],
    members: [],
    kanbanState: { teamName, reviewers: [], tasks: {} },
    processes: [],
  } as unknown as TeamViewSnapshot;
}

function snapshot(): TeamViewSnapshot {
  return snapshotFor(TEAM);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('selectTeam stale read recovery', () => {
  beforeEach(() => {
    __resetTeamSliceModuleStateForTests();
    resetSelectTeamLoadLatchForTests();
    clearAllTeamLocalStateEpochs();
    vi.clearAllMocks();
  });

  it('reloads instead of latching the skeleton when the snapshot is invalidated mid-read', async () => {
    const store = createHarnessStore();
    const first = deferred<TeamViewSnapshot>();
    apiMock.teams.getData.mockReturnValueOnce(first.promise).mockResolvedValue(snapshot());

    const load = store.getState().selectTeam(TEAM, { skipProjectAutoSelect: true });
    await vi.waitFor(() => expect(apiMock.teams.getData).toHaveBeenCalledTimes(1));
    // A team change event lands while the first read is in flight, bumping the
    // team-local state epoch so the in-flight read is discarded as stale.
    invalidateTeamLocalStateEpoch(TEAM);
    first.resolve(snapshot());
    await load;

    await vi.waitFor(() => {
      expect(store.getState().selectedTeamLoading).toBe(false);
      expect(store.getState().selectedTeamData?.teamName).toBe(TEAM);
    });
    expect(apiMock.teams.getData).toHaveBeenCalledTimes(2);
  });

  it('releases the loading state after the retry budget when every read is stale', async () => {
    const store = createHarnessStore();
    apiMock.teams.getData.mockImplementation(async () => {
      invalidateTeamLocalStateEpoch(TEAM);
      return snapshot();
    });

    await store.getState().selectTeam(TEAM, { skipProjectAutoSelect: true });

    await vi.waitFor(() => expect(store.getState().selectedTeamLoading).toBe(false), {
      timeout: 4000,
    });
    expect(apiMock.teams.getData).toHaveBeenCalledTimes(SELECT_TEAM_STALE_RETRY_LIMIT + 1);
    expect(store.getState().selectedTeamName).toBe(TEAM);
    // Releasing the latch must surface a retriable error, not a silent empty view.
    expect(store.getState().selectedTeamError).toContain('stale reads');
    const warn = vi.mocked(console.warn);
    expect(warn.mock.calls.flat().join(' ')).toContain('stale reads; releasing loading state');
    warn.mockClear();
  });

  it('resets the retry budget on a fresh selection after switching away mid-load', async () => {
    const store = createHarnessStore();
    const OTHER = 'other-team';
    apiMock.teams.getData.mockImplementation(async (teamName: string) => {
      invalidateTeamLocalStateEpoch(teamName);
      return snapshotFor(teamName);
    });

    await store.getState().selectTeam(TEAM, { skipProjectAutoSelect: true });
    await vi.waitFor(() => expect(apiMock.teams.getData).toHaveBeenCalledTimes(1));
    // Switching away mid-load leaves the consumed retry budget behind on TEAM.
    await store.getState().selectTeam(OTHER, { skipProjectAutoSelect: true });
    await vi.waitFor(() => expect(store.getState().selectedTeamLoading).toBe(false), {
      timeout: 4000,
    });
    const callsBeforeReselect = apiMock.teams.getData.mock.calls.length;

    // A fresh selection must run the full stale-read budget again: if the
    // abandoned load leaked its retry count, this run would exhaust earlier
    // and perform fewer reads.
    await store.getState().selectTeam(TEAM, { skipProjectAutoSelect: true });
    await vi.waitFor(() => expect(store.getState().selectedTeamLoading).toBe(false), {
      timeout: 4000,
    });
    expect(apiMock.teams.getData.mock.calls.length - callsBeforeReselect).toBe(
      SELECT_TEAM_STALE_RETRY_LIMIT + 1
    );
    vi.mocked(console.warn).mockClear();
  });

  it('holds an explicit provisioning signal instead of retrying it as a stale read', async () => {
    const store = createHarnessStore();
    // No provisioning run is recorded in the renderer yet, so the provisioning maps
    // cannot tell this intentional hold apart from a latched stale read.
    apiMock.teams.getData.mockRejectedValue(new Error('TEAM_PROVISIONING'));

    await store.getState().selectTeam(TEAM, { skipProjectAutoSelect: true });

    expect(store.getState().selectedTeamLoading).toBe(true);
    expect(store.getState().selectedTeamError).toBeNull();

    // The hold belongs to the provisioning progress callback: the stale-read retry
    // must neither re-read the team nor surface a false load error for it.
    await new Promise((resolve) =>
      setTimeout(resolve, SELECT_TEAM_STALE_RETRY_BASE_DELAY_MS * (SELECT_TEAM_STALE_RETRY_LIMIT + 1))
    );
    expect(apiMock.teams.getData).toHaveBeenCalledTimes(1);
    expect(store.getState().selectedTeamLoading).toBe(true);
    expect(store.getState().selectedTeamError).toBeNull();
  });
});
