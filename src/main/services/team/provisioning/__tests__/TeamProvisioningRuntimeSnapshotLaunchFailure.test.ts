import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLiveTeamAgentRuntimeMetadata,
  buildTeamAgentRuntimeSnapshot,
} from '../TeamProvisioningRuntimeSnapshot';

import type { RuntimeTelemetryProcessTableRow } from '../../TeamRuntimeTelemetry';
import type {
  RuntimeAdapterRunSnapshotSource,
  TeamProvisioningRuntimeSnapshotRun,
} from '../TeamProvisioningRuntimeSnapshotTypes';
import type { PersistedTeamLaunchMemberState, PersistedTeamLaunchSnapshot } from '@shared/types';

vi.mock('@features/tmux-installer/main', () => ({
  listTmuxPaneRuntimeInfoForCurrentPlatform: vi.fn(async () => new Map()),
}));

vi.mock('../../TeamBootstrapStateReader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../TeamBootstrapStateReader')>();
  return { ...actual, readBootstrapLaunchSnapshot: vi.fn(async () => null) };
});

const TEAM_NAME = 'test-failed-launch-runtime-snapshot';
const MEMBER_NAME = 'Worker';
const CURRENT_RUN_ID = 'run-current';
const UPDATED_AT = '2026-11-25T13:00:00.000Z';
const FAILURE_REASON = 'local-lab/missing-test:0.5b is not served by the local provider';

function failedMember(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: MEMBER_NAME,
    providerId: 'opencode',
    model: 'local-lab/missing-test:0.5b',
    launchState: 'failed_to_start',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: true,
    hardFailureReason: FAILURE_REASON,
    lastEvaluatedAt: UPDATED_AT,
    ...overrides,
  };
}

async function buildSnapshot(
  member: PersistedTeamLaunchMemberState,
  options: {
    activeOwner?: 'tracked' | 'adapter';
    processRows?: RuntimeTelemetryProcessTableRow[];
  } = {}
) {
  const runId = options.activeOwner === 'tracked' ? CURRENT_RUN_ID : null;
  const runs = new Map<string, TeamProvisioningRuntimeSnapshotRun>();
  const runtimeAdapterRunByTeam = new Map<string, RuntimeAdapterRunSnapshotSource>();
  const configuredMembers = [{ name: MEMBER_NAME, providerId: 'opencode' as const }];
  if (runId) {
    runs.set(runId, {
      runId,
      child: null,
      request: { teamName: TEAM_NAME, cwd: '/test-only/failed-launch', members: configuredMembers },
    });
  }
  if (options.activeOwner === 'adapter') {
    runtimeAdapterRunByTeam.set(TEAM_NAME, {
      runId: CURRENT_RUN_ID,
      providerId: 'opencode',
    });
  }
  const launchSnapshot: PersistedTeamLaunchSnapshot = {
    version: 2,
    teamName: TEAM_NAME,
    updatedAt: UPDATED_AT,
    launchPhase: 'finished',
    expectedMembers: [MEMBER_NAME],
    members: { [MEMBER_NAME]: member },
    summary: { confirmedCount: 0, pendingCount: 0, failedCount: 1, runtimeAlivePendingCount: 0 },
    teamLaunchState: 'partial_failure',
  };
  const ports = {
    teamName: TEAM_NAME,
    runId,
    generationAtStart: 0,
    runs,
    runtimeAdapterRunByTeam,
    teamMetaStore: { getMeta: async () => ({ providerId: 'opencode' as const }) },
    membersMetaStore: { getMembers: async () => [] },
    launchStateStore: { read: async () => launchSnapshot },
    readConfigSnapshot: async () => ({ name: TEAM_NAME, members: configuredMembers }),
    readPersistedRuntimeMembers: () => [
      {
        name: MEMBER_NAME,
        agentId: MEMBER_NAME,
        backendType: 'process',
        providerId: 'opencode',
        ...(options.activeOwner ? { bootstrapRunId: CURRENT_RUN_ID } : {}),
      },
    ],
    getRuntimeSnapshotCacheGeneration: () => 0,
    getTrackedRunId: () => runId,
    getAgentRuntimeSnapshotCacheTtlMs: () => 1_000,
    logDebug: vi.fn(),
  };
  const liveMetadata = await buildLiveTeamAgentRuntimeMetadata({
    ...ports,
    readRuntimeProcessRowsForLiveRuntimeMetadata: async () => ({
      rows: options.processRows ?? [],
      processTableAvailable: true,
    }),
    readWindowsHostProcessRowsForLiveRuntimeMetadata: async () => ({
      rows: [],
      processTableAvailable: false,
    }),
    liveRuntimeMetadataCache: { rememberLiveTeamAgentRuntimeMetadata: vi.fn() },
  });
  return buildTeamAgentRuntimeSnapshot({
    ...ports,
    getMemberSpawnStatuses: async () => ({ statuses: {}, runId }),
    getLiveTeamAgentRuntimeMetadata: async () => liveMetadata,
    readRuntimeProcessRowsForUsageSnapshot: async () => options.processRows ?? [],
    readProcessUsageStatsByPid: async () => new Map(),
    buildRuntimeUsageProcessTrees: () => new Map(),
    buildRuntimeProcessLoadStats: () => undefined,
    agentRuntimeResourceHistory: { record: () => undefined, prune: vi.fn() },
    rememberAgentRuntimeSnapshot: vi.fn(),
  });
}

describe('runtime snapshot after failed launch cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    { hardFailure: true, launchState: 'failed_to_start' as const },
    { hardFailure: false, launchState: 'failed_to_start' as const },
    { hardFailure: true, launchState: 'runtime_pending_bootstrap' as const },
  ])('keeps registered metadata offline for persisted failure %j', async (failure) => {
    const snapshot = await buildSnapshot(failedMember(failure));

    expect(snapshot.runId).toBeNull();
    expect(snapshot.members.Worker).toMatchObject({
      alive: false,
      livenessKind: 'registered_only',
      runtimeDiagnostic: FAILURE_REASON,
      runtimeDiagnosticSeverity: 'warning',
    });
  });

  it('does not revive historical bootstrap flags carried by a failed member', async () => {
    const snapshot = await buildSnapshot(
      failedMember({
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        lastHeartbeatAt: UPDATED_AT,
        runtimeRunId: 'run-old',
      })
    );

    expect(snapshot.members.Worker).toMatchObject({
      alive: false,
      livenessKind: 'registered_only',
      runtimeDiagnostic: FAILURE_REASON,
    });
  });

  it('does not revive a successful historical bootstrap without current ownership', async () => {
    const snapshot = await buildSnapshot(
      failedMember({
        launchState: 'confirmed_alive',
        hardFailure: false,
        hardFailureReason: undefined,
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        lastHeartbeatAt: UPDATED_AT,
        runtimeRunId: 'run-old',
        runtimePid: 4242,
      })
    );

    expect(snapshot.members.Worker?.alive).toBe(false);
    expect(snapshot.members.Worker?.livenessKind).not.toBe('confirmed_bootstrap');
  });

  it.each(['tracked', 'adapter'] as const)(
    'does not apply an unowned failure to a current %s run',
    async (activeOwner) => {
      for (const runtimeRunId of [undefined, 'run-old']) {
        const snapshot = await buildSnapshot(failedMember({ runtimeRunId }), { activeOwner });

        expect(snapshot.members.Worker).toMatchObject({
          alive: true,
          livenessKind: 'registered_only',
        });
        expect(snapshot.members.Worker?.runtimeDiagnostic).not.toContain(FAILURE_REASON);
      }
    }
  );

  it('ignores a persisted failure whose record key and member name disagree', async () => {
    const snapshot = await buildSnapshot(failedMember({ name: 'OtherWorker' }));

    expect(Object.keys(snapshot.members)).toEqual([MEMBER_NAME]);
    expect(snapshot.members.Worker).toMatchObject({ alive: true, livenessKind: 'registered_only' });
    expect(snapshot.members.Worker?.runtimeDiagnostic).not.toContain(FAILURE_REASON);
  });

  it('preserves independently verified process liveness after a recorded failure', async () => {
    const snapshot = await buildSnapshot(failedMember(), {
      processRows: [
        {
          pid: 4242,
          ppid: 1,
          command: `opencode run --team-name ${TEAM_NAME} --agent-id ${MEMBER_NAME}`,
        },
      ],
    });

    expect(snapshot.members.Worker).toMatchObject({
      alive: true,
      livenessKind: 'runtime_process',
      pid: 4242,
    });
  });
});
