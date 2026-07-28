import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import {
  createTeamProvisioningRuntimeSlice,
  getCurrentProvisioningProgressForTeam,
  isTeamProvisioningActive,
  resetTeamProvisioningRuntimeSliceForTests,
  type TeamProvisioningRuntimeSlice,
} from '../../../src/renderer/store/team/createTeamProvisioningRuntimeSlice';
import { TeamStateLifecycleCoordinator } from '../../../src/renderer/store/team/TeamStateLifecycleCoordinator';
import { invalidateContextScopedRequestEpoch } from '../../../src/renderer/store/utils/contextScopedRequestEpoch';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '../../../src/shared/types/team';

import type { AppState } from '../../../src/renderer/store/types';
import type {
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
  ToolApprovalSettings,
} from '../../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  cancelProvisioning: vi.fn(async () => undefined),
  createTeam: vi.fn(),
  getMemberSpawnStatuses: vi.fn(),
  getProvisioningStatus: vi.fn(),
  getTeamAgentRuntime: vi.fn(),
  launchTeam: vi.fn(),
  onProvisioningProgress: vi.fn(() => () => undefined),
  recordTeamLaunchEnd: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      cancelProvisioning: hoisted.cancelProvisioning,
      createTeam: hoisted.createTeam,
      getMemberSpawnStatuses: hoisted.getMemberSpawnStatuses,
      getProvisioningStatus: hoisted.getProvisioningStatus,
      getTeamAgentRuntime: hoisted.getTeamAgentRuntime,
      launchTeam: hoisted.launchTeam,
      onProvisioningProgress: hoisted.onProvisioningProgress,
    },
  },
}));

vi.mock('@renderer/analytics/productAnalytics', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/renderer/analytics/productAnalytics')>();
  return {
    ...actual,
    recordTeamLaunchEnd: hoisted.recordTeamLaunchEnd,
  };
});

interface HarnessState extends TeamProvisioningRuntimeSlice {
  activeContextId: string;
  fetchTeams(): Promise<void>;
  paneLayout: AppState['paneLayout'];
  refreshTeamData(teamName: string, options: { withDedup: true }): Promise<void>;
  selectTeam(teamName: string, options?: { allowReloadWhileProvisioning: true }): Promise<void>;
  selectedTeamData: AppState['selectedTeamData'];
  selectedTeamError: string | null;
  selectedTeamLoading: boolean;
  selectedTeamName: string | null;
  teamByName: AppState['teamByName'];
  teamDataCacheByName: AppState['teamDataCacheByName'];
  teamMessagesByName: AppState['teamMessagesByName'];
  toolApprovalSettings: ToolApprovalSettings;
  toolApprovalSettingsByTeam: Record<string, ToolApprovalSettings>;
}

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    state: 'assembling',
    message: 'Assembling team',
    startedAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:01.000Z',
    ...overrides,
  };
}

function runtimeSnapshot(
  overrides: Partial<TeamAgentRuntimeSnapshot> = {}
): TeamAgentRuntimeSnapshot {
  return {
    teamName: 'team-a',
    runId: 'run-1',
    updatedAt: '2026-07-28T10:00:01.000Z',
    members: {},
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(options: { selectedTeamName?: string | null } = {}) {
  const clearRuntimeFreshness = vi.fn();
  const lifecycleCoordinator = new TeamStateLifecycleCoordinator({ reset: vi.fn() });
  const fetchTeams = vi.fn(async () => undefined);
  const refreshTeamData = vi.fn(async () => undefined);
  const selectTeam = vi.fn(async () => undefined);

  const store = create<HarnessState>()((set, get) => {
    const setState = (
      update: Partial<AppState> | ((state: AppState) => Partial<AppState>)
    ): void => {
      if (typeof update === 'function') {
        set((state) => update(state as unknown as AppState) as Partial<HarnessState>);
        return;
      }
      set(update as Partial<HarnessState>);
    };

    return {
      ...createTeamProvisioningRuntimeSlice({
        lifecycle: {
          clearRuntimeFreshness: (teamName) => {
            clearRuntimeFreshness(teamName);
            lifecycleCoordinator.clearRuntimeFreshness(teamName);
          },
          clearTeam: (teamName) => lifecycleCoordinator.clearTeam(teamName),
          createRuntimeObservationSlice: (dependencies) =>
            lifecycleCoordinator.createRuntimeObservationSlice(dependencies),
        },
        log: {
          debug: vi.fn(),
        },
        state: {
          getState: () => get() as unknown as AppState,
          setState,
        },
      }),
      activeContextId: 'context-a',
      fetchTeams,
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
      },
      refreshTeamData,
      selectTeam,
      selectedTeamData: null,
      selectedTeamError: null,
      selectedTeamLoading: false,
      selectedTeamName: options.selectedTeamName ?? null,
      teamByName: {},
      teamDataCacheByName: {},
      teamMessagesByName: {},
      toolApprovalSettings: DEFAULT_TOOL_APPROVAL_SETTINGS,
      toolApprovalSettingsByTeam: {},
    };
  });

  return {
    clearRuntimeFreshness,
    fetchTeams,
    lifecycleCoordinator,
    store,
  };
}

describe('createTeamProvisioningRuntimeSlice', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTeamProvisioningRuntimeSliceForTests();
    vi.clearAllMocks();
    hoisted.createTeam.mockResolvedValue({ runId: 'run-1' });
    hoisted.getMemberSpawnStatuses.mockResolvedValue(null);
    hoisted.getProvisioningStatus.mockResolvedValue(progress({ state: 'ready' }));
    hoisted.getTeamAgentRuntime.mockResolvedValue(null);
    hoisted.launchTeam.mockResolvedValue({ runId: 'run-1' });
    hoisted.onProvisioningProgress.mockReturnValue(() => undefined);
  });

  it('assembles factory state in compatibility order and keeps canonical progress helpers pinned', () => {
    localStorage.setItem(
      'team:launchParams:team-a',
      JSON.stringify({
        providerId: 'codex',
        model: 'gpt-5.3-codex',
      })
    );

    const { store } = createHarness();

    expect(store.getState()).toMatchObject({
      provisioningRuns: {},
      provisioningSnapshotByTeam: {},
      currentProvisioningRunIdByTeam: {},
      currentRuntimeRunIdByTeam: {},
      ignoredProvisioningRunIds: {},
      ignoredRuntimeRunIds: {},
      provisioningStartedAtFloorByTeam: {},
      leadActivityByTeam: {},
      leadContextByTeam: {},
      activeTaskLogActivityByTeam: {},
      activeToolsByTeam: {},
      finishedVisibleByTeam: {},
      toolHistoryByTeam: {},
      memberSpawnStatusesByTeam: {},
      memberSpawnSnapshotsByTeam: {},
      teamAgentRuntimeByTeam: {},
      provisioningErrorByTeam: {},
    });
    expect(store.getState().launchParamsByTeam['team-a']).toEqual({
      providerId: 'codex',
      model: 'gpt-5.3-codex',
    });

    const current = progress();
    store.setState({
      provisioningRuns: {
        [current.runId]: current,
        stale: progress({ runId: 'stale', state: 'failed' }),
      },
      currentProvisioningRunIdByTeam: { 'team-a': current.runId },
    });

    expect(getCurrentProvisioningProgressForTeam(store.getState(), 'team-a')).toBe(current);
    expect(isTeamProvisioningActive(store.getState(), 'team-a')).toBe(true);

    store.setState({ currentProvisioningRunIdByTeam: {} });
    expect(getCurrentProvisioningProgressForTeam(store.getState(), 'team-a')).toBeNull();
    expect(isTeamProvisioningActive(store.getState(), 'team-a')).toBe(false);
  });

  it('preserves object and functional state updates without duplicating progress events', () => {
    const { clearRuntimeFreshness, store } = createHarness();
    let storeUpdates = 0;
    const unsubscribe = store.subscribe(() => {
      storeUpdates += 1;
    });
    const incoming = progress();

    store.getState().subscribeProvisioningProgress();
    expect(hoisted.onProvisioningProgress).toHaveBeenCalledTimes(1);
    expect(store.getState().provisioningProgressUnsubscribe).toEqual(expect.any(Function));

    const updatesAfterSubscription = storeUpdates;
    store.getState().onProvisioningProgress(incoming);
    store.getState().onProvisioningProgress(incoming);
    expect(storeUpdates - updatesAfterSubscription).toBe(1);

    store.getState().clearMissingProvisioningRun(incoming.runId);
    expect(store.getState().provisioningRuns[incoming.runId]).toBeUndefined();
    expect(clearRuntimeFreshness).toHaveBeenCalledWith('team-a');
    unsubscribe();
  });

  it('suppresses the launch factory isolated toolApprovalSettings update', async () => {
    const selectedSettings: ToolApprovalSettings = {
      ...DEFAULT_TOOL_APPROVAL_SETTINGS,
      timeoutAction: 'deny',
    };
    const { store } = createHarness({ selectedTeamName: 'other-team' });
    store.setState({
      toolApprovalSettings: selectedSettings,
      toolApprovalSettingsByTeam: {
        'other-team': selectedSettings,
      },
    });

    await store.getState().createTeam({
      teamName: 'team-a',
      cwd: '/tmp/test-project',
      members: [],
      skipPermissions: true,
    });

    expect(store.getState().toolApprovalSettings).toEqual(selectedSettings);
    expect(store.getState().toolApprovalSettingsByTeam['team-a']).toEqual({
      ...DEFAULT_TOOL_APPROVAL_SETTINGS,
      autoAllowAll: true,
    });
  });

  it('keeps runtime observations scoped to the lifecycle coordinator context epoch', async () => {
    const runtimeResult = deferred<TeamAgentRuntimeSnapshot | null>();
    hoisted.getTeamAgentRuntime.mockReturnValue(runtimeResult.promise);
    const { store } = createHarness();
    store.setState({
      currentRuntimeRunIdByTeam: { 'team-a': 'run-1' },
    });

    const fetchPromise = store.getState().fetchTeamAgentRuntime('team-a');
    invalidateContextScopedRequestEpoch();
    runtimeResult.resolve(runtimeSnapshot());
    await fetchPromise;

    expect(store.getState().teamAgentRuntimeByTeam['team-a']).toBeUndefined();
  });

  it('resets shared analytics dedupe state while retaining duplicate-event prevention', () => {
    const terminal = progress({
      state: 'disconnected',
      message: 'Runtime disconnected',
    });
    const firstStore = createHarness().store;
    firstStore.getState().onProvisioningProgress(terminal);
    firstStore.getState().onProvisioningProgress(terminal);
    expect(hoisted.recordTeamLaunchEnd).toHaveBeenCalledTimes(1);

    const secondStore = createHarness().store;
    secondStore.getState().onProvisioningProgress(terminal);
    expect(hoisted.recordTeamLaunchEnd).toHaveBeenCalledTimes(1);

    resetTeamProvisioningRuntimeSliceForTests();
    const resetStore = createHarness().store;
    resetStore.getState().onProvisioningProgress(terminal);
    expect(hoisted.recordTeamLaunchEnd).toHaveBeenCalledTimes(2);
  });
});
