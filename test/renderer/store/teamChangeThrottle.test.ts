import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  onTeamChangeCb: null as
    | ((
        event: unknown,
        data: {
          type?: string;
          teamName: string;
          detail?: string;
          runId?: string;
          taskId?: string;
          taskSignalKind?: 'log' | 'change';
        }
      ) => void)
    | null,
  onProvisioningProgressCb: null as
    | ((event: unknown, data: { runId: string; teamName: string }) => void)
    | null,
}));

vi.mock('@renderer/api', () => ({
  api: {
    config: {
      get: vi.fn(async () => ({
        general: { theme: 'dark' },
        notifications: { enabled: true, triggers: [] },
      })),
    },
    getRepositoryGroups: vi.fn(async () => []),
    notifications: {
      onNew: vi.fn(() => () => undefined),
      onUpdated: vi.fn(() => () => undefined),
      onClicked: vi.fn(() => () => undefined),
      get: vi.fn(async () => ({
        notifications: [],
        total: 0,
        totalCount: 0,
        unreadCount: 0,
        hasMore: false,
      })),
    },
    teams: {
      setChangePresenceTracking: vi.fn(async () => undefined),
      setToolActivityTracking: vi.fn(async () => undefined),
      setTaskLogStreamTracking: vi.fn(async () => undefined),
      onTeamChange: vi.fn(
        (
          cb: (
            event: unknown,
            data: {
              teamName: string;
              type?: string;
              detail?: string;
              runId?: string;
              taskId?: string;
              taskSignalKind?: 'log' | 'change';
            }
          ) => void
        ): (() => void) => {
          hoisted.onTeamChangeCb = cb;
          return () => {
            hoisted.onTeamChangeCb = null;
          };
        }
      ),
      onProvisioningProgress: vi.fn(
        (cb: (event: unknown, data: { runId: string; teamName: string }) => void): (() => void) => {
          hoisted.onProvisioningProgressCb = cb;
          return () => {
            hoisted.onProvisioningProgressCb = null;
          };
        }
      ),
      getAllTasks: vi.fn(async () => []),
      list: vi.fn(async () => []),
    },
    schedules: {
      list: vi.fn(async () => []),
      onScheduleChange: vi.fn(() => () => undefined),
    },
  },
}));

import { api } from '@renderer/api';

import { initializeNotificationListeners, useStore } from '../../../src/renderer/store';
import { createLoadingMultimodelCliStatus } from '../../../src/renderer/store/slices/cliInstallerSlice';
import { __resetTeamSliceModuleStateForTests } from '../../../src/renderer/store/slices/teamSlice';
import {
  __resetTeamRefreshFanoutDiagnosticsForTests,
  getTeamRefreshFanoutSnapshotForTests,
  summarizeTeamRefreshFanout,
  type TeamRefreshFanoutSnapshot,
} from '../../../src/renderer/store/teamRefreshFanoutDiagnostics';

describe('team change throttling', () => {
  let cleanup: (() => void) | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    __resetTeamSliceModuleStateForTests();
    __resetTeamRefreshFanoutDiagnosticsForTests();
    const fetchTeams = vi.fn(async () => undefined);
    const fetchMemberSpawnStatuses = vi.fn(async () => undefined);
    const fetchTeamAgentRuntime = vi.fn(async () => undefined);
    const refreshTeamData = vi.fn(async () => undefined);
    const refreshTeamMessagesHead = vi.fn(async () => ({
      feedChanged: true,
      headChanged: true,
      feedRevision: 'rev-1',
    }));
    const refreshMemberActivityMeta = vi.fn(async () => undefined);
    const refreshTeamChangePresence = vi.fn(async () => undefined);

    useStore.setState({
      fetchTeams,
      fetchMemberSpawnStatuses,
      fetchTeamAgentRuntime,
      refreshTeamData,
      refreshTeamMessagesHead,
      refreshMemberActivityMeta,
      refreshTeamChangePresence,
      selectedTeamName: null,
      selectedTeamData: null,
      teamDataCacheByName: {},
      provisioningRuns: {},
      currentProvisioningRunIdByTeam: {},
      currentRuntimeRunIdByTeam: {},
      ignoredProvisioningRunIds: {},
      ignoredRuntimeRunIds: {},
      activeTaskLogActivityByTeam: {},
      memberSpawnStatusesByTeam: {},
      memberSpawnSnapshotsByTeam: {},
      teamAgentRuntimeByTeam: {},
      memberActivityMetaByTeam: {},
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 't1', type: 'team', teamName: 'my-team', label: 'my-team' }],
            activeTabId: 't1',
          },
        ],
      },
    } as never);

    cleanup = initializeNotificationListeners();

    // Flush microtask queue so the sequential init chain completes
    // before test assertions start (prevents init calls from leaking into spies).
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    __resetTeamSliceModuleStateForTests();
    __resetTeamRefreshFanoutDiagnosticsForTests();
    window.localStorage.removeItem('team:processLiteFanout');
    vi.mocked(console.warn).mockClear();
    vi.useRealTimers();
  });

  it('throttles both team list and detail refresh', async () => {
    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    // Fire 3 rapid events
    hoisted.onTeamChangeCb?.({}, { teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { teamName: 'my-team' });

    // Both are throttled — nothing called synchronously
    expect(fetchTeamsSpy).not.toHaveBeenCalled();
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();

    // Detail refresh fires at 800ms
    await vi.advanceTimersByTimeAsync(799);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });

    // List refresh fires at 2000ms
    expect(fetchTeamsSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchTeamsSpy).toHaveBeenCalledTimes(1);
  });

  it('does not scan repository groups during centralized startup initialization', async () => {
    const getRepositoryGroupsSpy = vi.mocked(api.getRepositoryGroups);
    getRepositoryGroupsSpy.mockClear();

    cleanup?.();
    cleanup = initializeNotificationListeners();
    await vi.advanceTimersByTimeAsync(0);

    expect(getRepositoryGroupsSpy).not.toHaveBeenCalled();
  });

  it('defers the initial global task fetch until the startup idle window', async () => {
    const fetchAllTasksSpy = vi.fn(async () => undefined);
    useStore.setState({ fetchAllTasks: fetchAllTasksSpy } as never);

    cleanup?.();
    cleanup = initializeNotificationListeners();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchAllTasksSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchAllTasksSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchAllTasksSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels the deferred initial global task fetch during listener cleanup', async () => {
    const fetchAllTasksSpy = vi.fn(async () => undefined);
    useStore.setState({ fetchAllTasks: fetchAllTasksSpy } as never);

    cleanup?.();
    cleanup = initializeNotificationListeners();
    await vi.advanceTimersByTimeAsync(0);
    cleanup();
    cleanup = null;

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchAllTasksSpy).not.toHaveBeenCalled();
  });

  it('loads OpenCode after four seconds outside the provider idle batch even when bootstrap is slow', async () => {
    const originalFetchConfig = useStore.getState().fetchConfig;
    const originalBootstrapCliStatus = useStore.getState().bootstrapCliStatus;
    const originalFetchCliProviderStatus = useStore.getState().fetchCliProviderStatus;
    const originalNavigatorPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
    const startupConfig = useStore.getState().appConfig;
    if (!startupConfig) {
      throw new Error('Expected startup config to be loaded by the test harness');
    }
    const fetchConfig = vi.fn(async () => {
      useStore.setState({
        appConfig: {
          ...startupConfig,
          general: {
            ...startupConfig.general,
            multimodelEnabled: true,
          },
        },
      });
    });
    let resolveBootstrap!: () => void;
    const bootstrapCompletion = new Promise<void>((resolve) => {
      resolveBootstrap = resolve;
    });
    const bootstrapCliStatus = vi.fn(() => {
      useStore.setState({ cliStatus: createLoadingMultimodelCliStatus() });
      return bootstrapCompletion;
    });
    const fetchCliProviderStatus = vi.fn(
      async (..._args: Parameters<typeof originalFetchCliProviderStatus>) => true
    );

    cleanup?.();
    cleanup = null;
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    });
    Object.assign(api, { cliInstaller: {} });
    useStore.setState({ fetchConfig, bootstrapCliStatus, fetchCliProviderStatus } as never);

    try {
      cleanup = initializeNotificationListeners();
      await vi.advanceTimersByTimeAsync(0);

      expect(api.cliInstaller).toBeDefined();
      expect(fetchConfig).toHaveBeenCalledTimes(1);
      expect(bootstrapCliStatus).toHaveBeenCalledWith({
        multimodelEnabled: true,
        providerStatusMode: 'defer',
      });
      expect(fetchCliProviderStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_999);
      expect(fetchCliProviderStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(fetchCliProviderStatus).toHaveBeenCalledWith('opencode', { silent: false });
      expect(fetchCliProviderStatus).toHaveBeenCalledTimes(1);

      resolveBootstrap();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchCliProviderStatus).toHaveBeenCalledWith('anthropic', { silent: false });
      expect(fetchCliProviderStatus).toHaveBeenCalledWith('codex', { silent: false });
      expect(
        fetchCliProviderStatus.mock.calls.filter(([providerId]) => providerId === 'opencode')
      ).toHaveLength(1);
    } finally {
      cleanup?.();
      cleanup = null;
      Reflect.deleteProperty(api, 'cliInstaller');
      if (originalNavigatorPlatform) {
        Object.defineProperty(window.navigator, 'platform', originalNavigatorPlatform);
      } else {
        Reflect.deleteProperty(window.navigator, 'platform');
      }
      useStore.setState({
        fetchConfig: originalFetchConfig,
        bootstrapCliStatus: originalBootstrapCliStatus,
        fetchCliProviderStatus: originalFetchCliProviderStatus,
      } as never);
    }
  });

  it('allows next refresh after throttle window passes', async () => {
    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.({}, { teamName: 'my-team' });
    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);

    // Second event after throttle window
    hoisted.onTeamChangeCb?.({}, { teamName: 'my-team' });
    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps process events on the existing structural refresh path and records fanout', async () => {
    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.({}, { type: 'process', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(800);

    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });

    const snapshot = getTeamRefreshFanoutSnapshotForTests(
      'my-team'
    ) as TeamRefreshFanoutSnapshot | null;
    expect(
      snapshot?.counts['team-change-listener:event:process:refreshTeamData:scheduled']
    ).toBe(1);
    expect(snapshot?.counts['team-change-listener:event:process:refreshTeamData:executed']).toBe(
      1
    );
  });

  it('uses process-lite for strict candidates and delays structural reconcile', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const fetchMemberSpawnStatusesSpy = vi.spyOn(state, 'fetchMemberSpawnStatuses');
    const fetchTeamAgentRuntimeSpy = vi.spyOn(state, 'fetchTeamAgentRuntime');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json' }
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMemberSpawnStatusesSpy).toHaveBeenCalledTimes(1);
    expect(fetchMemberSpawnStatusesSpy).toHaveBeenCalledWith('my-team');
    expect(fetchTeamAgentRuntimeSpy).not.toHaveBeenCalled();
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(fetchTeamsSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1999);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(fetchTeamsSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchTeamsSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(fetchTeamAgentRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(fetchTeamAgentRuntimeSpy).toHaveBeenCalledWith('my-team');

    const summary = summarizeTeamRefreshFanout('my-team');
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'dry-run:process-lite:processes-json-visible-runtime-context',
          operation: 'wouldUseProcessLite',
          phase: 'skipped',
        }),
        expect.objectContaining({
          reason: 'event:process-lite:structural-suppressed',
          operation: 'refreshTeamData',
          phase: 'skipped',
        }),
        expect.objectContaining({
          reason: 'event:process-lite',
          operation: 'fetchMemberSpawnStatuses',
          phase: 'executed',
        }),
        expect.objectContaining({
          reason: 'event:process-lite',
          operation: 'fetchTeamAgentRuntime',
          phase: 'executed',
        }),
        expect.objectContaining({
          reason: 'event:process-lite:structural-reconcile',
          operation: 'refreshTeamData',
          phase: 'executed',
        }),
        expect.objectContaining({
          reason: 'event:process-lite:structural-reconcile',
          operation: 'fetchTeams',
          phase: 'executed',
        }),
      ])
    );
  });

  it('uses process-lite when an active provisioning run exists without current runtime', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentProvisioningRunIdByTeam: { 'my-team': 'run-1' },
      provisioningRuns: {
        'run-1': {
          runId: 'run-1',
          teamName: 'my-team',
          state: 'spawning',
          message: 'Spawning',
          startedAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
      currentRuntimeRunIdByTeam: {},
    } as never);

    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');
    const fetchMemberSpawnStatusesSpy = vi.spyOn(state, 'fetchMemberSpawnStatuses');
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json' }
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMemberSpawnStatusesSpy).toHaveBeenCalledWith('my-team');
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchTeamsSpy).not.toHaveBeenCalled();
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();

    const summary = summarizeTeamRefreshFanout('my-team');
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'event:process-lite:structural-reconcile:suppressed-during-launch',
          operation: 'refreshTeamData',
          phase: 'skipped',
        }),
      ])
    );
  });

  it('keeps active launch process file events runtime-only before team data hydrates', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: null,
      currentProvisioningRunIdByTeam: { 'my-team': 'run-1' },
      provisioningRuns: {
        'run-1': {
          runId: 'run-1',
          teamName: 'my-team',
          state: 'spawning',
          message: 'Spawning',
          startedAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
      currentRuntimeRunIdByTeam: {},
    } as never);

    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');
    const fetchMemberSpawnStatusesSpy = vi.spyOn(state, 'fetchMemberSpawnStatuses');
    const fetchTeamAgentRuntimeSpy = vi.spyOn(state, 'fetchTeamAgentRuntime');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json' }
    );

    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(799);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(fetchMemberSpawnStatusesSpy).toHaveBeenCalledWith('my-team');
    expect(fetchTeamAgentRuntimeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMemberSpawnStatusesSpy).toHaveBeenCalledTimes(1);
    expect(fetchTeamAgentRuntimeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_200);
    expect(fetchTeamAgentRuntimeSpy).toHaveBeenCalledWith('my-team');
    expect(useStore.getState().selectedTeamData).toBeNull();
    expect(useStore.getState().teamDataCacheByName['my-team']).toBeUndefined();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchTeamsSpy).not.toHaveBeenCalled();
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();

    const summary = summarizeTeamRefreshFanout('my-team');
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'dry-run:process-lite:missing-visible-team-data',
          operation: 'wouldKeepStructuralProcess',
          phase: 'skipped',
        }),
        expect.objectContaining({
          reason: 'event:process-lite:structural-suppressed-during-launch',
          operation: 'refreshTeamData',
          phase: 'skipped',
        }),
      ])
    );
  });

  it('keeps active launch process file events structural when process-lite is disabled', async () => {
    window.localStorage.setItem('team:processLiteFanout', '0');
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: null,
      currentProvisioningRunIdByTeam: { 'my-team': 'run-1' },
      provisioningRuns: {
        'run-1': {
          runId: 'run-1',
          teamName: 'my-team',
          state: 'spawning',
          message: 'Spawning',
          startedAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
      currentRuntimeRunIdByTeam: {},
    } as never);

    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json' }
    );

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });
  });

  it('suppresses idle-watchdog structural refresh during active launch', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentProvisioningRunIdByTeam: { 'my-team': 'run-1' },
      provisioningRuns: {
        'run-1': {
          runId: 'run-1',
          teamName: 'my-team',
          state: 'spawning',
          message: 'Spawning',
          startedAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json', runId: 'run-1' }
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
  });

  it('keeps idle-watchdog structural refresh available when process-lite is disabled', async () => {
    window.localStorage.setItem('team:processLiteFanout', '0');
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentProvisioningRunIdByTeam: { 'my-team': 'run-1' },
      provisioningRuns: {
        'run-1': {
          runId: 'run-1',
          teamName: 'my-team',
          state: 'spawning',
          message: 'Spawning',
          startedAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'lead-activity', teamName: 'my-team', detail: 'active', runId: 'run-1' }
    );

    await vi.advanceTimersByTimeAsync(59_999);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });
  });

  it('does not treat terminal or unknown provisioning states as process-lite active', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentProvisioningRunIdByTeam: { 'my-team': 'run-1' },
      provisioningRuns: {
        'run-1': {
          runId: 'run-1',
          teamName: 'my-team',
          state: 'ready',
          message: 'Ready',
          startedAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
      currentRuntimeRunIdByTeam: {},
    } as never);

    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json' }
    );

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });
  });

  it('keeps unsafe process details structural during active launch', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentProvisioningRunIdByTeam: { 'my-team': 'run-1' },
      provisioningRuns: {
        'run-1': {
          runId: 'run-1',
          teamName: 'my-team',
          state: 'spawning',
          message: 'Spawning',
          startedAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');
    const fetchMemberSpawnStatusesSpy = vi.spyOn(useStore.getState(), 'fetchMemberSpawnStatuses');

    hoisted.onTeamChangeCb?.({}, { type: 'process', teamName: 'my-team', detail: 'failed' });

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMemberSpawnStatusesSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });

    const summary = summarizeTeamRefreshFanout('my-team');
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'dry-run:process-lite:unsafe-process-detail',
          operation: 'wouldKeepStructuralProcess',
          phase: 'skipped',
        }),
      ])
    );
  });

  it('keeps strict process candidates on the structural path when process-lite is disabled', async () => {
    window.localStorage.setItem('team:processLiteFanout', '0');
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');
    const fetchTeamAgentRuntimeSpy = vi.spyOn(state, 'fetchTeamAgentRuntime');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json' }
    );

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });
    expect(fetchTeamAgentRuntimeSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchTeamsSpy).toHaveBeenCalledTimes(1);

    const summary = summarizeTeamRefreshFanout('my-team');
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'event:process-lite:disabled',
          operation: 'wouldKeepStructuralProcess',
          phase: 'skipped',
        }),
      ])
    );
  });

  it('coalesces process-lite structural reconcile until idle or max wait', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json' }
    );
    for (let elapsed = 2_000; elapsed <= 14_000; elapsed += 2_000) {
      await vi.advanceTimersByTimeAsync(2_000);
      hoisted.onTeamChangeCb?.(
        {},
        { type: 'process', teamName: 'my-team', detail: 'processes.json' }
      );
      expect(refreshTeamDataSpy).not.toHaveBeenCalled();
      expect(fetchTeamsSpy).not.toHaveBeenCalled();
    }

    await vi.advanceTimersByTimeAsync(999);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchTeamsSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels pending process-lite structural reconcile when launch becomes active', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json' }
    );

    await vi.advanceTimersByTimeAsync(500);
    useStore.setState({
      currentProvisioningRunIdByTeam: { 'my-team': 'run-2' },
      provisioningRuns: {
        'run-2': {
          runId: 'run-2',
          teamName: 'my-team',
          state: 'spawning',
          message: 'Spawning',
          startedAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-2' },
    } as never);
    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json', runId: 'run-2' }
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchTeamsSpy).not.toHaveBeenCalled();
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();

    const summary = summarizeTeamRefreshFanout('my-team');
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'event:process-lite:structural-reconcile:cancelled-during-launch',
          operation: 'refreshTeamData',
          phase: 'skipped',
        }),
      ])
    );
  });

  it('skips pending process-lite structural reconcile if provisioning becomes active before the timer fires', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json', runId: 'run-1' }
    );

    await vi.advanceTimersByTimeAsync(500);
    useStore.setState({
      currentProvisioningRunIdByTeam: { 'my-team': 'run-2' },
      provisioningRuns: {
        'run-2': {
          runId: 'run-2',
          teamName: 'my-team',
          state: 'spawning',
          message: 'Spawning',
          startedAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-2' },
    } as never);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchTeamsSpy).not.toHaveBeenCalled();
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();

    const summary = summarizeTeamRefreshFanout('my-team');
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'event:process-lite:structural-reconcile:suppressed-during-launch',
          operation: 'refreshTeamData',
          phase: 'skipped',
        }),
      ])
    );
  });

  it('keeps pending process-lite structural reconcile available when process-lite is disabled before the timer fires', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json', runId: 'run-1' }
    );

    await vi.advanceTimersByTimeAsync(500);
    window.localStorage.setItem('team:processLiteFanout', '0');
    useStore.setState({
      currentProvisioningRunIdByTeam: { 'my-team': 'run-2' },
      provisioningRuns: {
        'run-2': {
          runId: 'run-2',
          teamName: 'my-team',
          state: 'spawning',
          message: 'Spawning',
          startedAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-2' },
    } as never);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchTeamsSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });
  });

  it('cancels pending process-lite reconcile when a normal structural event wins', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json' }
    );
    await vi.advanceTimersByTimeAsync(500);
    hoisted.onTeamChangeCb?.({}, { type: 'task', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);
  });

  it('does not let process-lite coalescing weaken member-spawn runtime refresh semantics', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const state = useStore.getState();
    const fetchMemberSpawnStatusesSpy = vi.spyOn(state, 'fetchMemberSpawnStatuses');
    const fetchTeamAgentRuntimeSpy = vi.spyOn(state, 'fetchTeamAgentRuntime');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json' }
    );
    hoisted.onTeamChangeCb?.({}, { type: 'member-spawn', teamName: 'my-team' });

    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 't2', type: 'team', teamName: 'other-team', label: 'other-team' }],
            activeTabId: 't2',
          },
        ],
      },
    } as never);

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMemberSpawnStatusesSpy).toHaveBeenCalledTimes(1);
    expect(fetchMemberSpawnStatusesSpy).toHaveBeenCalledWith('my-team');
    expect(fetchTeamAgentRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(fetchTeamAgentRuntimeSpy).toHaveBeenCalledWith('my-team');
  });

  it('cleans up pending process-lite reconcile timers', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'my-team', detail: 'processes.json' }
    );
    cleanup?.();
    cleanup = null;

    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchTeamsSpy).not.toHaveBeenCalled();
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
  });

  it('records unsafe process details as structural dry-run without changing refresh behavior', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      currentRuntimeRunIdByTeam: { 'my-team': 'run-1' },
    } as never);

    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');

    hoisted.onTeamChangeCb?.({}, { type: 'process', teamName: 'my-team', detail: 'cancelled' });

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });

    const summary = summarizeTeamRefreshFanout('my-team');
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'dry-run:process-lite:unsafe-process-detail',
          operation: 'wouldKeepStructuralProcess',
          phase: 'skipped',
        }),
      ])
    );
  });

  it('keeps hidden process events out of visible detail refresh while recording structural dry-run', async () => {
    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 't1', type: 'team', teamName: 'my-team', label: 'my-team' }],
            activeTabId: 't1',
          },
        ],
      },
      teamDataCacheByName: {
        'other-team': {
          teamName: 'other-team',
          config: { name: 'Other Team', members: [], projectPath: '/repo' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
      currentRuntimeRunIdByTeam: { 'other-team': 'run-1' },
    } as never);

    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      { type: 'process', teamName: 'other-team', detail: 'processes.json' }
    );

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).not.toHaveBeenCalledWith('other-team', { withDedup: true });

    const summary = summarizeTeamRefreshFanout('other-team');
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'dry-run:process-lite:hidden-team',
          operation: 'wouldKeepStructuralProcess',
          phase: 'skipped',
        }),
      ])
    );
  });

  it('keeps task and config events on the existing global task refresh path', async () => {
    const fetchAllTasksSpy = vi.fn(async () => undefined);
    useStore.setState({ fetchAllTasks: fetchAllTasksSpy } as never);

    hoisted.onTeamChangeCb?.({}, { type: 'task', teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { type: 'config', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(500);

    expect(fetchAllTasksSpy).toHaveBeenCalledTimes(1);

    const snapshot = getTeamRefreshFanoutSnapshotForTests(
      'my-team'
    ) as TeamRefreshFanoutSnapshot | null;
    expect(snapshot?.counts['team-change-listener:event:task:fetchAllTasks:scheduled']).toBe(1);
    expect(snapshot?.counts['team-change-listener:event:config:fetchAllTasks:coalesced']).toBe(1);
    expect(snapshot?.counts['team-change-listener:event:task:fetchAllTasks:executed']).toBe(1);
    expect(snapshot?.counts['team-change-listener:event:config:fetchAllTasks:executed']).toBe(1);
  });

  it('slows global task refreshes during active provisioning', async () => {
    const fetchAllTasksSpy = vi.fn(async () => undefined);
    useStore.setState({
      fetchAllTasks: fetchAllTasksSpy,
      currentProvisioningRunIdByTeam: { 'my-team': 'run-1' },
      provisioningRuns: {
        'run-1': {
          runId: 'run-1',
          teamName: 'my-team',
          state: 'spawning',
          message: 'Spawning',
          startedAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
    } as never);

    await vi.advanceTimersByTimeAsync(5000);
    fetchAllTasksSpy.mockClear();

    hoisted.onTeamChangeCb?.({}, { type: 'task', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchAllTasksSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchAllTasksSpy).toHaveBeenCalledTimes(1);
  });

  it('lead-message refreshes message head only, not team list, tasks, or structural detail', async () => {
    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');
    const refreshTeamMessagesHeadSpy = vi.spyOn(state, 'refreshTeamMessagesHead');
    const refreshMemberActivityMetaSpy = vi.spyOn(state, 'refreshMemberActivityMeta');

    // Emit a lead-message event
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });

    // Should NOT trigger fetchTeams
    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchTeamsSpy).not.toHaveBeenCalled();

    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('my-team');
    expect(refreshMemberActivityMetaSpy).toHaveBeenCalledTimes(1);
    expect(refreshMemberActivityMetaSpy).toHaveBeenCalledWith('my-team');
  });

  it('lead-message refreshes visible graph tabs even when the team is not selected', async () => {
    useStore.setState({
      selectedTeamName: 'other-team',
      selectedTeamData: {
        teamName: 'other-team',
        config: { name: 'Other Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
        processes: [],
      },
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 'g1', type: 'graph', teamName: 'my-team', label: 'My Team Graph' }],
            activeTabId: 'g1',
          },
        ],
      },
    } as never);

    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');
    const refreshTeamMessagesHeadSpy = vi.spyOn(useStore.getState(), 'refreshTeamMessagesHead');

    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('my-team');
  });

  it('lead-message refreshes hidden teams with an active pending-reply wait state', async () => {
    useStore.getState().syncTeamPendingReplyRefresh('other-team', 'tab-hidden', true, 60_000);
    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 't1', type: 'team', teamName: 'my-team', label: 'my-team' }],
            activeTabId: 't1',
          },
        ],
      },
    } as never);

    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');
    const refreshTeamMessagesHeadSpy = vi.spyOn(useStore.getState(), 'refreshTeamMessagesHead');
    const refreshMemberActivityMetaSpy = vi.spyOn(useStore.getState(), 'refreshMemberActivityMeta');

    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'other-team' });

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('other-team');
    expect(refreshMemberActivityMetaSpy).toHaveBeenCalledWith('other-team');
  });

  it('lead-message does not refresh hidden inactive teams without pending replies', async () => {
    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 't1', type: 'team', teamName: 'my-team', label: 'my-team' }],
            activeTabId: 't1',
          },
        ],
      },
    } as never);

    const refreshTeamMessagesHeadSpy = vi.spyOn(useStore.getState(), 'refreshTeamMessagesHead');
    const refreshMemberActivityMetaSpy = vi.spyOn(useStore.getState(), 'refreshMemberActivityMeta');

    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'other-team' });

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamMessagesHeadSpy).not.toHaveBeenCalledWith('other-team');
    expect(refreshMemberActivityMetaSpy).not.toHaveBeenCalledWith('other-team');
  });

  it('member-spawn refreshes spawn statuses without forcing structural refresh', async () => {
    const fetchMemberSpawnStatusesSpy = vi.spyOn(useStore.getState(), 'fetchMemberSpawnStatuses');
    const refreshTeamDataSpy = vi.spyOn(useStore.getState(), 'refreshTeamData');

    hoisted.onTeamChangeCb?.({}, { type: 'member-spawn', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMemberSpawnStatusesSpy).toHaveBeenCalledWith('my-team');
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
  });

  it('inbox/config/process do not refresh member spawn statuses by default', async () => {
    const fetchMemberSpawnStatusesSpy = vi.spyOn(useStore.getState(), 'fetchMemberSpawnStatuses');

    hoisted.onTeamChangeCb?.({}, { type: 'inbox', teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { type: 'config', teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { type: 'process', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(800);
    expect(fetchMemberSpawnStatusesSpy).not.toHaveBeenCalled();
  });

  it('lead-message does not call fetchAllTasks', async () => {
    const fetchAllTasksSpy = vi.fn(async () => undefined);
    useStore.setState({ fetchAllTasks: fetchAllTasksSpy } as never);

    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchAllTasksSpy).not.toHaveBeenCalled();
  });

  it('fallback polling refreshes hidden teams with an active pending-reply wait state', async () => {
    useStore.getState().syncTeamPendingReplyRefresh('other-team', 'tab-hidden', true, 60_000);
    const refreshTeamMessagesHeadSpy = vi.spyOn(useStore.getState(), 'refreshTeamMessagesHead');
    const refreshMemberActivityMetaSpy = vi.spyOn(useStore.getState(), 'refreshMemberActivityMeta');

    await vi.advanceTimersByTimeAsync(10_000);

    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('other-team');
    expect(refreshMemberActivityMetaSpy).toHaveBeenCalledWith('other-team');
  });

  it('log-source-change refreshes only task change presence', async () => {
    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
    } as never);

    const state = useStore.getState();
    const fetchTeamsSpy = vi.spyOn(state, 'fetchTeams');
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');
    const refreshTeamChangePresenceSpy = vi.spyOn(state, 'refreshTeamChangePresence');

    hoisted.onTeamChangeCb?.({}, { type: 'log-source-change', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(399);
    expect(refreshTeamChangePresenceSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refreshTeamChangePresenceSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamChangePresenceSpy).toHaveBeenCalledWith('my-team');
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(fetchTeamsSpy).not.toHaveBeenCalled();
  });

  it('log-source-change refreshes visible graph tab change presence for non-selected teams', async () => {
    useStore.setState({
      selectedTeamName: 'other-team',
      selectedTeamData: {
        teamName: 'other-team',
        config: { name: 'Other Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
        processes: [],
      },
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team', members: [], projectPath: '/repo' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 'g1', type: 'graph', teamName: 'my-team', label: 'My Team Graph' }],
            activeTabId: 'g1',
          },
        ],
      },
    } as never);

    const refreshTeamChangePresenceSpy = vi.spyOn(useStore.getState(), 'refreshTeamChangePresence');

    hoisted.onTeamChangeCb?.({}, { type: 'log-source-change', teamName: 'my-team' });

    await vi.advanceTimersByTimeAsync(400);
    expect(refreshTeamChangePresenceSpy).toHaveBeenCalledWith('my-team');
  });

  it('keeps background polling disabled for unknown in-progress tasks', async () => {
    const invalidateTaskChangePresence = vi.fn();
    const checkTaskHasChanges = vi.fn(async () => undefined);

    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [
          {
            id: 'task-1',
            owner: 'alice',
            status: 'in_progress',
            createdAt: '2026-03-01T10:00:00.000Z',
            updatedAt: '2026-03-01T10:00:00.000Z',
            workIntervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
            historyEvents: [],
            reviewState: 'none',
            changePresence: 'unknown',
          },
          {
            id: 'task-2',
            owner: 'alice',
            status: 'in_progress',
            createdAt: '2026-03-01T10:00:00.000Z',
            updatedAt: '2026-03-01T10:00:00.000Z',
            workIntervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
            historyEvents: [],
            reviewState: 'none',
            changePresence: 'unknown',
          },
        ],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
      invalidateTaskChangePresence,
      checkTaskHasChanges,
    } as never);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(checkTaskHasChanges).not.toHaveBeenCalled();
  });

  it('keeps background polling disabled for visible non-selected graph teams', async () => {
    const invalidateTaskChangePresence = vi.fn();
    const checkTaskHasChanges = vi.fn(async () => undefined);

    useStore.setState({
      selectedTeamName: 'other-team',
      selectedTeamData: {
        teamName: 'other-team',
        config: { name: 'Other Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'other-team', reviewers: [], tasks: {} },
        processes: [],
      },
      teamDataCacheByName: {
        'my-team': {
          teamName: 'my-team',
          config: { name: 'My Team', members: [], projectPath: '/repo' },
          tasks: [
            {
              id: 'task-1',
              owner: 'alice',
              status: 'in_progress',
              createdAt: '2026-03-01T10:00:00.000Z',
              updatedAt: '2026-03-01T10:00:00.000Z',
              workIntervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
              historyEvents: [],
              reviewState: 'none',
              changePresence: 'unknown',
            },
            {
              id: 'task-2',
              owner: 'alice',
              status: 'in_progress',
              createdAt: '2026-03-01T10:00:00.000Z',
              updatedAt: '2026-03-01T10:00:00.000Z',
              workIntervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
              historyEvents: [],
              reviewState: 'none',
              changePresence: 'unknown',
            },
          ],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        },
      },
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 'g1', type: 'graph', teamName: 'my-team', label: 'My Team Graph' }],
            activeTabId: 'g1',
          },
        ],
      },
      invalidateTaskChangePresence,
      checkTaskHasChanges,
    } as never);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(checkTaskHasChanges).not.toHaveBeenCalled();
  });

  it('per-team throttling: busy team does not block another visible team', async () => {
    // Add a second visible team tab
    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 0.5,
            tabs: [{ id: 't1', type: 'team', teamName: 'my-team', label: 'my-team' }],
            activeTabId: 't1',
          },
          {
            id: 'p2',
            widthFraction: 0.5,
            tabs: [{ id: 't2', type: 'team', teamName: 'other-team', label: 'other-team' }],
            activeTabId: 't2',
          },
        ],
      },
    } as never);

    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');
    const refreshTeamMessagesHeadSpy = vi.spyOn(state, 'refreshTeamMessagesHead');

    // Fire rapid events for my-team (throttled)
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'my-team' });

    // Fire event for other-team — should NOT be blocked by my-team's throttle
    hoisted.onTeamChangeCb?.({}, { type: 'lead-message', teamName: 'other-team' });

    await vi.advanceTimersByTimeAsync(800);

    // Both teams should get exactly 1 refresh each
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledTimes(2);
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('my-team');
    expect(refreshTeamMessagesHeadSpy).toHaveBeenCalledWith('other-team');
  });

  it('keeps auto change presence tracking disabled even after selected team data is hydrated', async () => {
    const setChangePresenceTrackingSpy = vi.mocked(api.teams.setChangePresenceTracking);
    setChangePresenceTrackingSpy.mockClear();

    expect(setChangePresenceTrackingSpy).not.toHaveBeenCalled();

    useStore.setState({
      selectedTeamName: 'my-team',
      selectedTeamData: {
        teamName: 'my-team',
        config: { name: 'My Team', members: [], projectPath: '/repo' },
        tasks: [],
        members: [],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      },
    } as never);

    await Promise.resolve();

    expect(setChangePresenceTrackingSpy).not.toHaveBeenCalled();

    useStore.setState({
      selectedTeamName: 'other-team',
      selectedTeamData: null,
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 't2', type: 'team', teamName: 'other-team', label: 'other-team' }],
            activeTabId: 't2',
          },
        ],
      },
    } as never);

    await Promise.resolve();

    expect(setChangePresenceTrackingSpy).not.toHaveBeenCalled();
  });

  it('tracks visible team tabs for tool activity and disables tracking when tab disappears', async () => {
    const setToolActivityTrackingSpy = vi.mocked(api.teams.setToolActivityTracking);
    setToolActivityTrackingSpy.mockClear();

    cleanup?.();
    cleanup = initializeNotificationListeners();
    await vi.advanceTimersByTimeAsync(0);

    expect(setToolActivityTrackingSpy).toHaveBeenCalledWith('my-team', true);

    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [{ id: 'p1', widthFraction: 1, tabs: [], activeTabId: null }],
      },
    } as never);

    await vi.advanceTimersByTimeAsync(0);

    expect(setToolActivityTrackingSpy).toHaveBeenCalledWith('my-team', false);
  });

  it('tracks visible graph tabs for tool activity and disables tracking when graph tab disappears', async () => {
    const setToolActivityTrackingSpy = vi.mocked(api.teams.setToolActivityTracking);
    setToolActivityTrackingSpy.mockClear();

    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [
          {
            id: 'p1',
            widthFraction: 1,
            tabs: [{ id: 'g1', type: 'graph', teamName: 'my-team', label: 'My Team Graph' }],
            activeTabId: 'g1',
          },
        ],
      },
    } as never);

    cleanup?.();
    cleanup = initializeNotificationListeners();
    await vi.advanceTimersByTimeAsync(0);

    expect(setToolActivityTrackingSpy).toHaveBeenCalledWith('my-team', true);

    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [{ id: 'p1', widthFraction: 1, tabs: [], activeTabId: null }],
      },
    } as never);

    await vi.advanceTimersByTimeAsync(0);
    expect(setToolActivityTrackingSpy).toHaveBeenCalledWith('my-team', false);
  });

  it('tracks visible team tabs for task log activity and disables tracking when tab disappears', async () => {
    const setTaskLogStreamTrackingSpy = vi.mocked(api.teams.setTaskLogStreamTracking);
    setTaskLogStreamTrackingSpy.mockClear();

    cleanup?.();
    cleanup = initializeNotificationListeners();
    await vi.advanceTimersByTimeAsync(0);

    expect(setTaskLogStreamTrackingSpy).toHaveBeenCalledWith('my-team', true);

    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [{ id: 'p1', widthFraction: 1, tabs: [], activeTabId: null }],
      },
    } as never);

    await vi.advanceTimersByTimeAsync(0);

    expect(setTaskLogStreamTrackingSpy).toHaveBeenCalledWith('my-team', false);
  });

  it('pulses task log activity only for real log signals and clears it after inactivity', async () => {
    hoisted.onTeamChangeCb?.({}, {
      type: 'task-log-change',
      teamName: 'my-team',
      taskId: 'task-change-only',
      taskSignalKind: 'change',
    });

    expect(useStore.getState().activeTaskLogActivityByTeam['my-team']).toBeUndefined();

    useStore.setState({ currentRuntimeRunIdByTeam: { 'my-team': 'run-current' } } as never);
    hoisted.onTeamChangeCb?.({}, {
      type: 'task-log-change',
      teamName: 'my-team',
      runId: 'run-old',
      taskId: 'task-stale',
      taskSignalKind: 'log',
    });

    expect(useStore.getState().activeTaskLogActivityByTeam['my-team']).toBeUndefined();

    hoisted.onTeamChangeCb?.({}, {
      type: 'task-log-change',
      teamName: 'my-team',
      runId: 'run-current',
      taskId: 'task-live',
      taskSignalKind: 'log',
    });

    expect(useStore.getState().activeTaskLogActivityByTeam['my-team']).toEqual({
      'task-live': true,
    });

    await vi.advanceTimersByTimeAsync(3499);
    expect(useStore.getState().activeTaskLogActivityByTeam['my-team']).toEqual({
      'task-live': true,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(useStore.getState().activeTaskLogActivityByTeam['my-team']).toBeUndefined();
  });

  it('pulses visible task log activity without refreshing team data for explicit log signals', async () => {
    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      {
        type: 'task-log-change',
        teamName: 'my-team',
        taskId: 'task-live',
        taskSignalKind: 'log',
      }
    );

    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(useStore.getState().activeTaskLogActivityByTeam['my-team']).toEqual({
      'task-live': true,
    });

    await vi.advanceTimersByTimeAsync(800);

    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
  });

  it('refreshes visible team data for task change freshness without pulsing live log activity', async () => {
    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      {
        type: 'task-log-change',
        teamName: 'my-team',
        taskId: 'task-completed',
        taskSignalKind: 'change',
      }
    );

    expect(useStore.getState().activeTaskLogActivityByTeam['my-team']).toBeUndefined();

    await vi.advanceTimersByTimeAsync(800);

    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });
  });

  it('keeps the bounded team data refresh for legacy task log change events', async () => {
    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      {
        type: 'task-log-change',
        teamName: 'my-team',
        taskId: 'task-live',
        detail: 'opencode-runtime-task-event:start',
      }
    );

    expect(useStore.getState().activeTaskLogActivityByTeam['my-team']).toEqual({
      'task-live': true,
    });

    await vi.advanceTimersByTimeAsync(800);

    expect(refreshTeamDataSpy).toHaveBeenCalledTimes(1);
    expect(refreshTeamDataSpy).toHaveBeenCalledWith('my-team', { withDedup: true });
  });

  it('skips the bounded task log refresh if the team is hidden before execution', async () => {
    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');

    hoisted.onTeamChangeCb?.(
      {},
      {
        type: 'task-log-change',
        teamName: 'my-team',
        taskId: 'task-live',
        taskSignalKind: 'log',
      }
    );

    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [{ id: 'p1', widthFraction: 1, tabs: [], activeTabId: null }],
      },
    } as never);

    await vi.advanceTimersByTimeAsync(800);

    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
  });

  it('extends task log activity pulse on repeated log signals and ignores hidden teams', async () => {
    const state = useStore.getState();
    const refreshTeamDataSpy = vi.spyOn(state, 'refreshTeamData');
    const activitySnapshots: Array<Record<string, true> | undefined> = [];
    const unsubscribeActivitySnapshots = useStore.subscribe((nextState, prevState) => {
      if (nextState.activeTaskLogActivityByTeam !== prevState.activeTaskLogActivityByTeam) {
        activitySnapshots.push(nextState.activeTaskLogActivityByTeam['my-team']);
      }
    });

    hoisted.onTeamChangeCb?.({}, {
      type: 'task-log-change',
      teamName: 'my-team',
      taskId: 'task-live',
      taskSignalKind: 'log',
    });

    expect(activitySnapshots).toEqual([{ 'task-live': true }]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();

    hoisted.onTeamChangeCb?.({}, {
      type: 'task-log-change',
      teamName: 'my-team',
      taskId: 'task-live',
      taskSignalKind: 'log',
    });

    expect(activitySnapshots).toEqual([{ 'task-live': true }]);

    await vi.advanceTimersByTimeAsync(3499);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    expect(useStore.getState().activeTaskLogActivityByTeam['my-team']).toEqual({
      'task-live': true,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(useStore.getState().activeTaskLogActivityByTeam['my-team']).toBeUndefined();
    expect(activitySnapshots).toEqual([{ 'task-live': true }, undefined]);

    useStore.setState({
      paneLayout: {
        focusedPaneId: 'p1',
        panes: [{ id: 'p1', widthFraction: 1, tabs: [], activeTabId: null }],
      },
    } as never);

    hoisted.onTeamChangeCb?.({}, {
      type: 'task-log-change',
      teamName: 'my-team',
      taskId: 'task-hidden',
      taskSignalKind: 'log',
    });

    expect(useStore.getState().activeTaskLogActivityByTeam['my-team']).toBeUndefined();

    await vi.advanceTimersByTimeAsync(800);
    expect(refreshTeamDataSpy).not.toHaveBeenCalled();
    unsubscribeActivitySnapshots();
  });

  it('applies targeted tool resets without clearing sibling tools', async () => {
    useStore.setState({
      activeToolsByTeam: {
        'my-team': {
          alice: {
            'tool-a': {
              memberName: 'alice',
              toolUseId: 'tool-a',
              toolName: 'Read',
              startedAt: '2026-03-28T10:00:00.000Z',
              state: 'running',
              source: 'runtime',
            },
            'tool-b': {
              memberName: 'alice',
              toolUseId: 'tool-b',
              toolName: 'Bash',
              startedAt: '2026-03-28T10:00:01.000Z',
              state: 'running',
              source: 'runtime',
            },
          },
        },
      },
    } as never);

    hoisted.onTeamChangeCb?.({}, {
      type: 'tool-activity',
      teamName: 'my-team',
      detail: JSON.stringify({
        action: 'reset',
        memberName: 'alice',
        toolUseIds: ['tool-a'],
      }),
    });

    expect(useStore.getState().activeToolsByTeam['my-team']?.alice?.['tool-a']).toBeUndefined();
    expect(useStore.getState().activeToolsByTeam['my-team']?.alice?.['tool-b']).toBeDefined();
  });
});
