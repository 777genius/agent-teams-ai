import {
  createTeamViewDataRendererSlice,
  TeamViewDataCoordinator,
  type TeamViewDataRendererSlice,
  type TeamViewDataRendererState,
} from '@features/team-view-read-model/renderer';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TeamViewSnapshot } from '@shared/types';

const TEAM_NAME = 'sandbox-team';

function snapshot(name: string, overrides: Partial<TeamViewSnapshot> = {}): TeamViewSnapshot {
  return {
    teamName: TEAM_NAME,
    config: { name },
    tasks: [],
    members: [],
    kanbanState: {
      teamName: TEAM_NAME,
      reviewers: [],
      tasks: {},
    },
    processes: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(initialSnapshot: TeamViewSnapshot | null = null) {
  let state: TeamViewDataRendererState = {
    appConfig: null,
    globalTasks: [],
    globalTasksInitialized: false,
    reviewActionError: null,
    selectedTeamData: initialSnapshot,
    selectedTeamError: null,
    selectedTeamLoading: false,
    selectedTeamLoadNonce: 0,
    selectedTeamName: initialSnapshot?.teamName ?? null,
    teamByName: {},
    teamDataCacheByName: initialSnapshot ? { [initialSnapshot.teamName]: initialSnapshot } : {},
    toolApprovalSettings: DEFAULT_TOOL_APPROVAL_SETTINGS,
  };
  let currentScope = 0;
  const coordinator = new TeamViewDataCoordinator();
  const transport = {
    getData: vi.fn().mockResolvedValue(snapshot('loaded')),
    invalidateTaskChangeSummaries: vi.fn().mockResolvedValue(undefined),
  };
  const feedActions = {
    invalidateTaskChangePresence: vi.fn(),
    refreshMemberActivityMeta: vi.fn().mockResolvedValue(undefined),
    refreshTeamMessagesHead: vi.fn().mockResolvedValue({
      feedChanged: false,
      headChanged: false,
      feedRevision: null,
    }),
  };
  const lifecycle = {
    isMemberActivityMetaStale: vi.fn().mockReturnValue(false),
    isProvisioningActive: vi.fn().mockReturnValue(false),
    recordLastResolvedRefresh: vi.fn(),
    recordTaskBoardTransitions: vi.fn(),
    shouldInvalidateCachedData: vi.fn().mockReturnValue(false),
  };
  const snapshots = {
    getForTeam: (current: TeamViewDataRendererState, teamName: string) =>
      current.teamDataCacheByName[teamName] ??
      (current.selectedTeamName === teamName ? current.selectedTeamData : null),
    preserveKnownTaskChangePresence: (
      _teamName: string,
      _previous: TeamViewSnapshot['tasks'] | null | undefined,
      next: TeamViewSnapshot['tasks']
    ) => next,
    shouldPreserveSelectedSnapshot: vi.fn().mockReturnValue(false),
    structurallyShare: (
      _previous: TeamViewSnapshot | null | undefined,
      incoming: TeamViewSnapshot
    ) => incoming,
  };

  const actions = () => ({
    ...slice,
    ...feedActions,
  });
  const slice: TeamViewDataRendererSlice = createTeamViewDataRendererSlice({
    actions: {
      getActions: actions,
    },
    coordinator,
    diagnostics: {
      debug: vi.fn(),
      noteRefreshBurst: vi.fn(),
      warn: vi.fn(),
    },
    globalTasks: {
      buildNotification: () => null,
      notify: vi.fn(),
      project: (current) => current,
    },
    lifecycle,
    requestScope: {
      capture: () => currentScope,
      isCurrent: (_teamName, scope) => scope === currentScope,
    },
    selectionEffects: {
      autoSelectProject: vi.fn(),
      loadToolApprovalSettings: () => DEFAULT_TOOL_APPROVAL_SETTINGS,
      syncTabLabels: vi.fn(),
    },
    snapshots,
    state: {
      getState: () => state,
      setState: (update) => {
        const patch = typeof update === 'function' ? update(state) : update;
        state = { ...state, ...patch };
      },
    },
    tasks: {
      collectInvalidation: () => ({ cacheKeys: [], taskIds: [] }),
    },
    transport,
  });

  return {
    advanceScope: () => {
      currentScope += 1;
    },
    coordinator,
    feedActions,
    getState: () => state,
    lifecycle,
    slice,
    snapshots,
    transport,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TeamViewDataCoordinator', () => {
  it('keeps replacement request ownership when an older cleared request settles', async () => {
    const coordinator = new TeamViewDataCoordinator();
    const first = deferred<TeamViewSnapshot>();
    const second = deferred<TeamViewSnapshot>();

    const firstRequest = coordinator.requestDataDeduped(TEAM_NAME, undefined, () => first.promise);
    coordinator.clearTeam(TEAM_NAME);
    const secondRequest = coordinator.requestDataDeduped(
      TEAM_NAME,
      undefined,
      () => second.promise
    );

    first.resolve(snapshot('first'));
    await firstRequest;
    expect(coordinator.hasFullDataRequest(TEAM_NAME)).toBe(true);

    second.resolve(snapshot('second'));
    await secondRequest;
    expect(coordinator.hasFullDataRequest(TEAM_NAME)).toBe(false);
  });

  it('does not let stale refresh cleanup consume a replacement request follow-up', () => {
    const coordinator = new TeamViewDataCoordinator();
    const staleRequest = Promise.resolve(snapshot('stale'));
    const currentRequest = Promise.resolve(snapshot('current'));

    coordinator.markFreshRefreshPending(TEAM_NAME, staleRequest);
    coordinator.clearTeam(TEAM_NAME);
    coordinator.markFreshRefreshPending(TEAM_NAME, currentRequest);

    expect(coordinator.consumeFreshRefresh(TEAM_NAME, staleRequest)).toBe(false);
    expect(coordinator.snapshot(TEAM_NAME).hasPendingFreshTeamDataRefresh).toBe(true);
    expect(coordinator.consumeFreshRefresh(TEAM_NAME, currentRequest)).toBe(true);
  });

  it('runs post-paint work at most once and cancels the fallback path', async () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback) => setTimeout(() => callback(10), 10) as unknown as number
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) =>
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
    );
    const coordinator = new TeamViewDataCoordinator();
    const run = vi.fn();

    coordinator.schedulePostPaint(TEAM_NAME, run, 500);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot(TEAM_NAME).hasPostPaintTeamEnrichmentTimer).toBe(false);
  });
});

describe('createTeamViewDataRendererSlice', () => {
  it('queues repeated full refresh fanout behind thin selection and drains it once after paint', async () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const thin = deferred<TeamViewSnapshot>();
    const harness = createHarness();
    harness.transport.getData
      .mockImplementationOnce(() => thin.promise)
      .mockResolvedValueOnce(snapshot('full'));

    const selection = harness.slice.selectTeam(TEAM_NAME);
    await Promise.all([
      harness.slice.refreshTeamData(TEAM_NAME, { withDedup: true }),
      harness.slice.refreshTeamData(TEAM_NAME, { withDedup: true }),
      harness.slice.refreshTeamData(TEAM_NAME, { withDedup: true }),
    ]);
    expect(harness.transport.getData).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.snapshot(TEAM_NAME).hasQueuedFullTeamDataRefreshAfterThin).toBe(
      true
    );

    thin.resolve(snapshot('thin'));
    await selection;
    expect(harness.transport.getData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => {
      expect(harness.transport.getData).toHaveBeenCalledTimes(2);
    });
    expect(harness.coordinator.snapshot(TEAM_NAME).hasQueuedFullTeamDataRefreshAfterThin).toBe(
      false
    );
  });

  it('does not commit or rerun a pending refresh after its request scope becomes stale', async () => {
    const request = deferred<TeamViewSnapshot>();
    const harness = createHarness();
    harness.transport.getData.mockImplementationOnce(() => request.promise);

    const first = harness.slice.refreshTeamData(TEAM_NAME, { withDedup: true });
    const second = harness.slice.refreshTeamData(TEAM_NAME, { withDedup: true });
    harness.advanceScope();
    request.resolve(snapshot('stale'));
    await Promise.all([first, second]);

    expect(harness.getState().selectedTeamData).toBeNull();
    expect(harness.transport.getData).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.snapshot(TEAM_NAME).hasPendingFreshTeamDataRefresh).toBe(false);
  });

  it('lets only the newest same-team selection nonce commit a shared thin request', async () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const thin = deferred<TeamViewSnapshot>();
    const harness = createHarness();
    harness.transport.getData.mockImplementationOnce(() => thin.promise);

    const firstSelection = harness.slice.selectTeam(TEAM_NAME);
    const secondSelection = harness.slice.selectTeam(TEAM_NAME, {
      allowReloadWhileProvisioning: true,
    });
    expect(harness.transport.getData).toHaveBeenCalledTimes(1);

    thin.resolve(snapshot('thin'));
    await Promise.all([firstSelection, secondSelection]);

    expect(harness.getState().selectedTeamLoadNonce).toBe(2);
    expect(harness.getState().selectedTeamData?.config.name).toBe('thin');
    expect(harness.lifecycle.recordLastResolvedRefresh).toHaveBeenCalledTimes(1);
    harness.coordinator.clearTeam(TEAM_NAME);
  });

  it('preserves a richer cached roster when the injected snapshot policy requires it', async () => {
    vi.useFakeTimers();
    const cached = snapshot('cached', {
      members: [
        {
          name: 'alice',
          agentId: 'alice',
          agentType: 'general-purpose',
          taskCount: 1,
          currentTaskId: null,
        },
      ],
    });
    const harness = createHarness(cached);
    harness.snapshots.shouldPreserveSelectedSnapshot.mockReturnValue(true);
    harness.transport.getData.mockResolvedValueOnce(snapshot('thin'));

    await harness.slice.selectTeam(TEAM_NAME);

    expect(harness.getState().selectedTeamData).toBe(cached);
    expect(harness.getState().teamDataCacheByName[TEAM_NAME]).toBe(cached);
    harness.coordinator.clearTeam(TEAM_NAME);
  });
});
