import {
  createTeamProvisioningLaunchSlice,
  type TeamLaunchParams,
  type TeamProvisioningLaunchMessageEntry,
  type TeamProvisioningLaunchStoreState,
  type TeamProvisioningLaunchTransportPort,
} from '@features/team-provisioning/renderer';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { describe, expect, it, vi } from 'vitest';

import type { TeamProvisioningProgress } from '@shared/types';

type MessageEntry = TeamProvisioningLaunchMessageEntry;
interface AnalyticsContext {
  source: 'create' | 'launch';
}

function createProgress(
  runId: string,
  state: TeamProvisioningProgress['state'] = 'ready'
): TeamProvisioningProgress {
  return {
    runId,
    teamName: 'sandbox-team',
    state,
    message: state === 'ready' ? 'Ready' : 'Starting',
    startedAt: '2026-07-23T10:00:00.000Z',
    updatedAt: '2026-07-23T10:00:01.000Z',
  };
}

function createState(
  overrides: Partial<TeamProvisioningLaunchStoreState<MessageEntry>> = {}
): TeamProvisioningLaunchStoreState<MessageEntry> {
  return {
    activeToolsByTeam: {},
    currentProvisioningRunIdByTeam: {},
    currentRuntimeRunIdByTeam: {},
    finishedVisibleByTeam: {},
    ignoredProvisioningRunIds: {},
    ignoredRuntimeRunIds: {},
    launchParamsByTeam: {},
    memberSpawnSnapshotsByTeam: {},
    memberSpawnStatusesByTeam: {},
    provisioningErrorByTeam: {},
    provisioningRuns: {},
    provisioningSnapshotByTeam: {},
    provisioningStartedAtFloorByTeam: {},
    selectedTeamError: null,
    selectedTeamLoading: false,
    selectedTeamName: null,
    teamAgentRuntimeByTeam: {},
    teamMessagesByName: {},
    toolApprovalSettings: DEFAULT_TOOL_APPROVAL_SETTINGS,
    toolHistoryByTeam: {},
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createHarness(
  initialState = createState(),
  transportOverrides: Partial<TeamProvisioningLaunchTransportPort> = {},
  getStatus = vi.fn((runId: string) => Promise.resolve(createProgress(runId)))
) {
  let state = initialState;
  let nowMs = 1_000;
  const analytics = {
    createContext: vi.fn(
      (): AnalyticsContext => ({
        source: 'create',
      })
    ),
    launchContext: vi.fn(
      (): AnalyticsContext => ({
        source: 'launch',
      })
    ),
    recordCreateAccepted: vi.fn(),
    recordIpcFailure: vi.fn(),
    recordLaunchAccepted: vi.fn(),
  };
  const clearMissingRun = vi.fn();
  const subscribe = vi.fn();
  const reset = vi.fn();
  const persistence = {
    loadAllLaunchParams: vi.fn(() => initialState.launchParamsByTeam),
    saveLaunchParams: vi.fn(),
    saveToolApprovalSettings: vi.fn(),
  };
  const transport: TeamProvisioningLaunchTransportPort = {
    create: vi.fn().mockResolvedValue({ runId: 'run-create' }),
    launch: vi.fn().mockResolvedValue({ runId: 'run-launch' }),
    ...transportOverrides,
  };
  const slice = createTeamProvisioningLaunchSlice<MessageEntry, AnalyticsContext>({
    analytics,
    clock: {
      nowIso: () => '2026-07-23T10:00:00.000Z',
      nowMs: () => ++nowMs,
      sleep: vi.fn().mockResolvedValue(undefined),
    },
    control: {
      clearMissingRun,
      getStatus,
      subscribe,
    },
    persistence,
    scope: {
      collectVisibleLoadingResets: (current, teamName) => {
        const entry = Object.entries(current.teamMessagesByName).find(
          ([entryTeamName]) => entryTeamName === teamName
        )?.[1];
        return {
          selectedTeamError:
            current.selectedTeamName === teamName ? null : current.selectedTeamError,
          selectedTeamLoading:
            current.selectedTeamName === teamName ? false : current.selectedTeamLoading,
          teamMessagesByName: entry
            ? Object.fromEntries(
                Object.entries(current.teamMessagesByName).map(([entryTeamName, currentEntry]) => [
                  entryTeamName,
                  entryTeamName === teamName
                    ? {
                        ...entry,
                        loadingHead: false,
                        loadingOlder: false,
                      }
                    : currentEntry,
                ])
              )
            : current.teamMessagesByName,
        };
      },
      getTeamData: () => null,
      reset,
    },
    state: {
      getState: () => state,
      setState: (update) => {
        const patch = typeof update === 'function' ? update(state) : update;
        state = { ...state, ...patch };
      },
    },
    transport,
  });
  state = {
    ...state,
    launchParamsByTeam: slice.launchParamsByTeam,
  };

  return {
    analytics,
    clearMissingRun,
    getState: () => state,
    getStatus,
    persistence,
    reset,
    setState: (update: Partial<TeamProvisioningLaunchStoreState<MessageEntry>>) => {
      state = { ...state, ...update };
    },
    slice,
    subscribe,
    transport,
  };
}

describe('createTeamProvisioningLaunchSlice', () => {
  it('preserves real progress that arrives before the create response', async () => {
    const deferred = createDeferred<{ runId: string }>();
    const harness = createHarness(createState(), {
      create: vi.fn(() => deferred.promise),
    });

    const creating = harness.slice.createTeam({
      teamName: 'sandbox-team',
      displayName: 'Sandbox Team',
      cwd: '/Users/test/sandbox-project',
      members: [],
      providerId: 'codex',
      model: 'gpt-5.6',
    });
    const pendingRunId = Object.keys(harness.getState().provisioningRuns)[0];
    const realProgress = createProgress('run-real', 'assembling');
    harness.setState({
      provisioningRuns: {
        ...harness.getState().provisioningRuns,
        [realProgress.runId]: realProgress,
      },
    });

    deferred.resolve({ runId: realProgress.runId });
    await expect(creating).resolves.toBe(realProgress.runId);

    expect(harness.getState().provisioningRuns).not.toHaveProperty(pendingRunId);
    expect(harness.getState().provisioningRuns[realProgress.runId]).toBe(realProgress);
    expect(harness.getState().currentProvisioningRunIdByTeam['sandbox-team']).toBe(
      realProgress.runId
    );
    expect(harness.getState().currentRuntimeRunIdByTeam['sandbox-team']).toBe(realProgress.runId);
    expect(harness.getState().provisioningSnapshotByTeam['sandbox-team']).toEqual(
      expect.objectContaining({
        displayName: 'Sandbox Team',
        teamName: 'sandbox-team',
      })
    );
    expect(harness.analytics.recordCreateAccepted).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'sandbox-team' }),
      realProgress.runId,
      { source: 'create' }
    );
  });

  it('clears stale runtime state and loading flags before launch transport resolves', async () => {
    const deferred = createDeferred<{ runId: string }>();
    const harness = createHarness(
      createState({
        activeToolsByTeam: { 'sandbox-team': { lead: {} } },
        currentRuntimeRunIdByTeam: { 'sandbox-team': 'run-old' },
        ignoredRuntimeRunIds: { 'run-older': 'sandbox-team' },
        provisioningErrorByTeam: { 'sandbox-team': 'Old failure' },
        provisioningRuns: {
          'run-old': createProgress('run-old', 'failed'),
        },
        selectedTeamError: 'Old load failure',
        selectedTeamLoading: true,
        selectedTeamName: 'sandbox-team',
        teamAgentRuntimeByTeam: {
          'sandbox-team': {
            runId: 'run-old',
            teamName: 'sandbox-team',
            updatedAt: '2026-07-23T09:59:00.000Z',
            members: {},
          },
        },
        teamMessagesByName: {
          'sandbox-team': {
            loadingHead: true,
            loadingOlder: true,
          },
        },
      }),
      {
        launch: vi.fn(() => deferred.promise),
      }
    );

    const launching = harness.slice.launchTeam({
      teamName: 'sandbox-team',
      cwd: '/Users/test/sandbox-project',
    });

    expect(harness.reset).toHaveBeenCalledWith('sandbox-team');
    expect(harness.subscribe).toHaveBeenCalledTimes(1);
    expect(harness.getState()).toEqual(
      expect.objectContaining({
        activeToolsByTeam: {},
        ignoredRuntimeRunIds: {
          'run-old': 'sandbox-team',
          'run-older': 'sandbox-team',
        },
        provisioningErrorByTeam: {},
        selectedTeamError: null,
        selectedTeamLoading: false,
        teamAgentRuntimeByTeam: {},
      })
    );
    expect(harness.getState().teamMessagesByName['sandbox-team']).toEqual({
      loadingHead: false,
      loadingOlder: false,
    });

    deferred.resolve({ runId: 'run-new' });
    await launching;
  });

  it('does not roll back newer params or a newer run after an early launch failure', async () => {
    const deferred = createDeferred<{ runId: string }>();
    const previousParams: TeamLaunchParams = {
      providerId: 'anthropic',
      model: 'sonnet',
      limitContext: false,
    };
    const newerParams: TeamLaunchParams = {
      providerId: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
      limitContext: true,
    };
    const harness = createHarness(
      createState({
        launchParamsByTeam: { 'sandbox-team': previousParams },
      }),
      {
        launch: vi.fn(() => deferred.promise),
      }
    );

    const launching = harness.slice.launchTeam({
      teamName: 'sandbox-team',
      cwd: '/Users/test/sandbox-project',
      providerId: 'anthropic',
      model: 'opus',
    });
    harness.setState({
      currentProvisioningRunIdByTeam: { 'sandbox-team': 'run-newer' },
      launchParamsByTeam: { 'sandbox-team': newerParams },
      provisioningRuns: {
        ...harness.getState().provisioningRuns,
        'run-newer': createProgress('run-newer', 'spawning'),
      },
    });

    const failure = new Error('launch IPC failed');
    deferred.reject(failure);
    await expect(launching).rejects.toBe(failure);

    expect(harness.getState().launchParamsByTeam['sandbox-team']).toBe(newerParams);
    expect(harness.getState().currentProvisioningRunIdByTeam['sandbox-team']).toBe('run-newer');
    expect(harness.getState().provisioningRuns['run-newer']).toBeDefined();
    expect(harness.getState().provisioningErrorByTeam['sandbox-team']).toBe(failure.message);
    expect(harness.analytics.recordIpcFailure).toHaveBeenCalledWith({ source: 'launch' }, failure);
  });

  it('does not overwrite newer launch params when an older launch response arrives late', async () => {
    const older = createDeferred<{ runId: string }>();
    const newer = createDeferred<{ runId: string }>();
    const launch = vi
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const harness = createHarness(createState(), { launch });

    const olderLaunch = harness.slice.launchTeam({
      teamName: 'sandbox-team',
      cwd: '/Users/test/sandbox-project',
      providerId: 'anthropic',
      model: 'opus',
    });
    const newerLaunch = harness.slice.launchTeam({
      teamName: 'sandbox-team',
      cwd: '/Users/test/sandbox-project',
      providerId: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
    });

    newer.resolve({ runId: 'run-newer' });
    await expect(newerLaunch).resolves.toBe('run-newer');
    const newerParams = harness.getState().launchParamsByTeam['sandbox-team'];
    expect(newerParams).toEqual(
      expect.objectContaining({
        providerId: 'codex',
        model: 'gpt-5.6',
        effort: 'high',
      })
    );

    older.resolve({ runId: 'run-older' });
    await expect(olderLaunch).resolves.toBe('run-older');

    expect(harness.getState().launchParamsByTeam['sandbox-team']).toBe(newerParams);
    expect(harness.getState().currentProvisioningRunIdByTeam['sandbox-team']).toBe('run-newer');
    expect(harness.getState().currentRuntimeRunIdByTeam['sandbox-team']).toBe('run-newer');
    expect(harness.getState().ignoredProvisioningRunIds['run-older']).toBe('sandbox-team');
    expect(harness.persistence.saveLaunchParams).toHaveBeenCalledTimes(1);
    expect(harness.persistence.saveLaunchParams).toHaveBeenCalledWith('sandbox-team', newerParams);
  });

  it('clears an accepted orphan when best-effort polling reports an unknown run', async () => {
    const getStatus = vi.fn().mockRejectedValue(new Error('Unknown runId: run-orphan'));
    const harness = createHarness(
      createState(),
      {
        launch: vi.fn().mockResolvedValue({ runId: 'run-orphan' }),
      },
      getStatus
    );

    await expect(
      harness.slice.launchTeam({
        teamName: 'sandbox-team',
        cwd: '/Users/test/sandbox-project',
      })
    ).resolves.toBe('run-orphan');

    await vi.waitFor(() => {
      expect(harness.clearMissingRun).toHaveBeenCalledWith('run-orphan');
    });
    expect(harness.analytics.recordIpcFailure).not.toHaveBeenCalled();
  });
});
