import { describe, expect, it, vi } from 'vitest';

import {
  buildLiveTeamAgentRuntimeMetadata,
  buildTeamAgentRuntimeSnapshot,
  type PersistedRuntimeMemberLike,
  type RuntimeAdapterRunSnapshotSource,
  type TeamProvisioningRuntimeSnapshotRun,
} from '../TeamProvisioningRuntimeSnapshot';

import type { RuntimeTelemetryProcessTableRow } from '../../TeamRuntimeTelemetry';
import type { LiveTeamAgentRuntimeMetadata } from '../TeamProvisioningRuntimeMetadataPolicy';
import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamConfig,
} from '@shared/types';

vi.mock('@features/tmux-installer/main', () => ({
  listTmuxPaneRuntimeInfoForCurrentPlatform: vi.fn(async () => new Map()),
}));

vi.mock('../../TeamBootstrapStateReader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../TeamBootstrapStateReader')>();
  return {
    ...actual,
    readBootstrapLaunchSnapshot: vi.fn(async () => null),
  };
});

const TEAM_NAME = 'runtime-snapshot-precedence-test';
const RUN_ID = 'run-current';
const OLD_RUN_ID = 'run-old';
const UPDATED_AT = '2026-01-01T00:00:00.000Z';
const CURRENT_PID = 222;
const OLD_PID = 111;
const WORKDIR = '/safe-test-workspace/runtime-snapshot-precedence-test';

function config(): TeamConfig {
  return {
    name: TEAM_NAME,
    members: [
      {
        name: 'Worker',
        providerId: 'opencode',
        model: 'gpt-current',
        cwd: WORKDIR,
      },
    ],
  };
}

function run(): TeamProvisioningRuntimeSnapshotRun {
  return {
    runId: RUN_ID,
    child: null,
    processKilled: false,
    cancelRequested: false,
    request: {
      teamName: TEAM_NAME,
      members: [
        {
          name: 'Worker',
          providerId: 'opencode',
          model: 'gpt-current',
          cwd: WORKDIR,
        },
      ],
      cwd: WORKDIR,
      providerId: 'opencode',
      model: 'gpt-current',
    },
    effectiveMembers: [
      {
        name: 'Worker',
        providerId: 'opencode',
        model: 'gpt-current',
        cwd: WORKDIR,
      },
    ],
    allEffectiveMembers: [
      {
        name: 'Worker',
        providerId: 'opencode',
        model: 'gpt-current',
        cwd: WORKDIR,
      },
    ],
    memberSpawnStatuses: new Map(),
  };
}

function confirmedOldLaunchMember(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Worker',
    providerId: 'opencode',
    model: 'gpt-old',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    runtimePid: OLD_PID,
    runtimeRunId: OLD_RUN_ID,
    runtimeSessionId: 'session-old',
    livenessKind: 'confirmed_bootstrap',
    pidSource: 'runtime_bootstrap',
    runtimeDiagnostic: 'old launch confirmed',
    runtimeDiagnosticSeverity: 'info',
    lastHeartbeatAt: UPDATED_AT,
    lastRuntimeAliveAt: UPDATED_AT,
    lastEvaluatedAt: UPDATED_AT,
    ...overrides,
  };
}

function launchSnapshot(member: PersistedTeamLaunchMemberState): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: TEAM_NAME,
    updatedAt: UPDATED_AT,
    launchPhase: 'finished',
    expectedMembers: ['Worker'],
    members: {
      Worker: member,
    },
    summary: {
      confirmedCount: member.bootstrapConfirmed ? 1 : 0,
      pendingCount: member.launchState === 'runtime_pending_bootstrap' ? 1 : 0,
      failedCount: member.hardFailure ? 1 : 0,
      runtimeAlivePendingCount: 0,
    },
    teamLaunchState: member.hardFailure ? 'partial_failure' : 'clean_success',
  };
}

function pendingSpawnStatus(
  overrides: Partial<MemberSpawnStatusEntry> = {}
): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    livenessKind: 'runtime_process_candidate',
    runtimeDiagnostic: 'current spawn is still pending bootstrap',
    runtimeDiagnosticSeverity: 'warning',
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function runtimeAdapterRun(
  overrides: {
    runId?: string;
    model?: string;
    runtimePid?: number;
    sessionId?: string;
    runtimeDiagnostic?: string;
  } = {}
): RuntimeAdapterRunSnapshotSource {
  return {
    runId: overrides.runId ?? RUN_ID,
    providerId: 'opencode',
    cwd: WORKDIR,
    members: {
      Worker: {
        memberName: 'Worker',
        providerId: 'opencode',
        model: overrides.model ?? 'gpt-current',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        runtimePid: overrides.runtimePid ?? CURRENT_PID,
        sessionId: overrides.sessionId ?? 'session-current',
        livenessKind: 'confirmed_bootstrap',
        pidSource: 'opencode_bridge',
        ...(overrides.runtimeDiagnostic ? { runtimeDiagnostic: overrides.runtimeDiagnostic } : {}),
        diagnostics: ['current runtime adapter evidence'],
      },
    },
  };
}

function processRows(): RuntimeTelemetryProcessTableRow[] {
  return [
    {
      pid: OLD_PID,
      ppid: 1,
      command: 'opencode run --team-name old --agent-id Worker',
    },
    {
      pid: CURRENT_PID,
      ppid: 1,
      command: 'opencode run --team-name runtime-snapshot-precedence-test --agent-id Worker',
    },
  ];
}

describe('TeamProvisioningRuntimeSnapshot source precedence', () => {
  it('preserves OpenCode runtime snapshot diagnostic compatibility at the mapper boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const liveRuntimeByMember = new Map<string, LiveTeamAgentRuntimeMetadata>([
        [
          'Worker',
          {
            alive: false,
            backendType: 'process',
            providerId: 'opencode',
            livenessKind: 'registered_only',
            pidSource: 'persisted_metadata',
            runtimeDiagnostic: 'registered runtime metadata without live process',
            runtimeDiagnosticSeverity: 'warning',
          },
        ],
      ]);

      const snapshot = await buildTeamAgentRuntimeSnapshot({
        teamName: TEAM_NAME,
        runId: RUN_ID,
        generationAtStart: 0,
        runs: new Map([[RUN_ID, run()]]),
        runtimeAdapterRunByTeam: new Map([[TEAM_NAME, runtimeAdapterRun()]]),
        teamMetaStore: {
          getMeta: vi.fn(async () => ({ providerId: 'opencode' as const })),
        },
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        },
        launchStateStore: {
          read: vi.fn(async () => null),
        },
        readConfigSnapshot: vi.fn(async () => config()),
        readPersistedRuntimeMembers: vi.fn(() => []),
        getMemberSpawnStatuses: vi.fn(
          async (): Promise<MemberSpawnStatusesSnapshot> => ({
            runId: RUN_ID,
            source: 'live',
            statuses: {},
          })
        ),
        getLiveTeamAgentRuntimeMetadata: vi.fn(async () => liveRuntimeByMember),
        readRuntimeProcessRowsForUsageSnapshot: vi.fn(async () => []),
        readProcessUsageStatsByPid: vi.fn(async () => new Map()),
        buildRuntimeUsageProcessTrees: vi.fn(() => new Map()),
        buildRuntimeProcessLoadStats: vi.fn(() => undefined),
        agentRuntimeResourceHistory: {
          record: vi.fn(() => undefined),
          prune: vi.fn(),
        },
        getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
        getTrackedRunId: vi.fn(() => RUN_ID),
        getAgentRuntimeSnapshotCacheTtlMs: vi.fn(() => 1_000),
        rememberAgentRuntimeSnapshot: vi.fn(),
        logDebug: vi.fn(),
      });

      expect(snapshot.members.Worker).toMatchObject({
        alive: true,
        livenessKind: 'confirmed_bootstrap',
        pidSource: 'runtime_bootstrap',
        pid: CURRENT_PID,
        runtimeSessionId: 'session-current',
        runtimeDiagnostic: 'OpenCode bootstrap confirmed; runtime host/session evidence present.',
        runtimeDiagnosticSeverity: 'info',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a stale persisted OpenCode launch confirmation override current spawn evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const liveRuntimeByMember = new Map<string, LiveTeamAgentRuntimeMetadata>([
        [
          'Worker',
          {
            alive: false,
            backendType: 'process',
            providerId: 'opencode',
            pid: CURRENT_PID,
            metricsPid: CURRENT_PID,
            livenessKind: 'runtime_process_candidate',
            pidSource: 'opencode_bridge',
            runtimeSessionId: 'session-current',
            runtimeDiagnostic:
              'OpenCode runtime process detected, but teammate bootstrap is not confirmed',
            runtimeDiagnosticSeverity: 'warning',
          },
        ],
      ]);
      const runs = new Map([[RUN_ID, run()]]);
      const snapshot = await buildTeamAgentRuntimeSnapshot({
        teamName: TEAM_NAME,
        runId: RUN_ID,
        generationAtStart: 0,
        runs,
        runtimeAdapterRunByTeam: new Map(),
        teamMetaStore: {
          getMeta: vi.fn(async () => ({ providerId: 'opencode' as const })),
        },
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        },
        launchStateStore: {
          read: vi.fn(async () => launchSnapshot(confirmedOldLaunchMember())),
        },
        readConfigSnapshot: vi.fn(async () => config()),
        readPersistedRuntimeMembers: vi.fn(() => []),
        getMemberSpawnStatuses: vi.fn(
          async (): Promise<MemberSpawnStatusesSnapshot> => ({
            runId: RUN_ID,
            source: 'live',
            statuses: {
              Worker: pendingSpawnStatus(),
            },
          })
        ),
        getLiveTeamAgentRuntimeMetadata: vi.fn(async () => liveRuntimeByMember),
        readRuntimeProcessRowsForUsageSnapshot: vi.fn(async () => processRows()),
        readProcessUsageStatsByPid: vi.fn(async () => new Map()),
        buildRuntimeUsageProcessTrees: vi.fn(() => new Map()),
        buildRuntimeProcessLoadStats: vi.fn(() => undefined),
        agentRuntimeResourceHistory: {
          record: vi.fn(() => undefined),
          prune: vi.fn(),
        },
        getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
        getTrackedRunId: vi.fn(() => RUN_ID),
        getAgentRuntimeSnapshotCacheTtlMs: vi.fn(() => 1_000),
        rememberAgentRuntimeSnapshot: vi.fn(),
        logDebug: vi.fn(),
      });

      expect(snapshot.members.Worker).toMatchObject({
        alive: false,
        livenessKind: 'runtime_process_candidate',
        pidSource: 'opencode_bridge',
        runtimeDiagnostic:
          'OpenCode runtime process detected, but teammate bootstrap is not confirmed',
      });
      expect(snapshot.members.Worker?.historicalBootstrapConfirmed).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers current runtime adapter process evidence over persisted launch pid metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const metadata = await buildLiveTeamAgentRuntimeMetadata({
        teamName: TEAM_NAME,
        runId: RUN_ID,
        generationAtStart: 0,
        runs: new Map([[RUN_ID, run()]]),
        runtimeAdapterRunByTeam: new Map([[TEAM_NAME, runtimeAdapterRun()]]),
        teamMetaStore: {
          getMeta: vi.fn(async () => ({ providerId: 'opencode' as const })),
        },
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        },
        launchStateStore: {
          read: vi.fn(async () => launchSnapshot(confirmedOldLaunchMember())),
        },
        readConfigSnapshot: vi.fn(async () => config()),
        readPersistedRuntimeMembers: vi.fn(
          () =>
            [
              {
                name: 'Worker',
                backendType: 'process',
                providerId: 'opencode',
                bootstrapRunId: OLD_RUN_ID,
                runtimePid: OLD_PID,
                runtimeSessionId: 'session-old',
                cwd: '/safe-test-workspace/old-runtime',
              },
            ] satisfies PersistedRuntimeMemberLike[]
        ),
        readRuntimeProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
          rows: processRows(),
          processTableAvailable: true,
        })),
        readWindowsHostProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
          rows: [],
          processTableAvailable: false,
        })),
        getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
        getTrackedRunId: vi.fn(() => RUN_ID),
        getAgentRuntimeSnapshotCacheTtlMs: vi.fn(() => 1_000),
        liveRuntimeMetadataCache: {
          rememberLiveTeamAgentRuntimeMetadata: vi.fn(),
        },
        logDebug: vi.fn(),
      });

      expect(metadata.get('Worker')).toMatchObject({
        alive: true,
        model: 'gpt-current',
        pid: CURRENT_PID,
        metricsPid: CURRENT_PID,
        pidSource: 'opencode_bridge',
        runtimeSessionId: 'session-current',
        runtimeDiagnostic: 'OpenCode runtime process detected after bootstrap confirmation',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale runtime adapter run evidence when resolving the active run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const metadata = await buildLiveTeamAgentRuntimeMetadata({
        teamName: TEAM_NAME,
        runId: RUN_ID,
        generationAtStart: 0,
        runs: new Map([[RUN_ID, run()]]),
        runtimeAdapterRunByTeam: new Map([
          [
            TEAM_NAME,
            runtimeAdapterRun({
              runId: OLD_RUN_ID,
              model: 'gpt-old',
              runtimePid: OLD_PID,
              sessionId: 'session-old',
              runtimeDiagnostic: 'stale adapter evidence',
            }),
          ],
        ]),
        teamMetaStore: {
          getMeta: vi.fn(async () => ({ providerId: 'opencode' as const })),
        },
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        },
        launchStateStore: {
          read: vi.fn(async () =>
            launchSnapshot(
              confirmedOldLaunchMember({
                model: 'gpt-current',
                runtimePid: CURRENT_PID,
                runtimeRunId: RUN_ID,
                runtimeSessionId: 'session-current',
                runtimeDiagnostic: 'current launch confirmed',
              })
            )
          ),
        },
        readConfigSnapshot: vi.fn(async () => config()),
        readPersistedRuntimeMembers: vi.fn(() => [] satisfies PersistedRuntimeMemberLike[]),
        readRuntimeProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
          rows: processRows(),
          processTableAvailable: true,
        })),
        readWindowsHostProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
          rows: [],
          processTableAvailable: false,
        })),
        getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
        getTrackedRunId: vi.fn(() => RUN_ID),
        getAgentRuntimeSnapshotCacheTtlMs: vi.fn(() => 1_000),
        liveRuntimeMetadataCache: {
          rememberLiveTeamAgentRuntimeMetadata: vi.fn(),
        },
        logDebug: vi.fn(),
      });

      expect(metadata.get('Worker')).toMatchObject({
        alive: true,
        model: 'gpt-current',
        pid: CURRENT_PID,
        metricsPid: CURRENT_PID,
        pidSource: 'opencode_bridge',
        runtimeSessionId: 'session-current',
      });
      expect(metadata.get('Worker')).not.toMatchObject({
        pid: OLD_PID,
        metricsPid: OLD_PID,
        runtimeSessionId: 'session-old',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not project stale persisted runtime pid or session metadata onto an active run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const metadata = await buildLiveTeamAgentRuntimeMetadata({
        teamName: TEAM_NAME,
        runId: RUN_ID,
        generationAtStart: 0,
        runs: new Map([[RUN_ID, run()]]),
        runtimeAdapterRunByTeam: new Map(),
        teamMetaStore: {
          getMeta: vi.fn(async () => ({ providerId: 'opencode' as const })),
        },
        membersMetaStore: {
          getMembers: vi.fn(async () => []),
        },
        launchStateStore: {
          read: vi.fn(async () => null),
        },
        readConfigSnapshot: vi.fn(async () => config()),
        readPersistedRuntimeMembers: vi.fn(
          () =>
            [
              {
                name: 'Worker',
                backendType: 'process',
                providerId: 'opencode',
                bootstrapRunId: OLD_RUN_ID,
                runtimePid: OLD_PID,
                runtimeSessionId: 'session-old',
                cwd: '/safe-test-workspace/old-runtime',
              },
            ] satisfies PersistedRuntimeMemberLike[]
        ),
        readRuntimeProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
          rows: processRows(),
          processTableAvailable: true,
        })),
        readWindowsHostProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
          rows: [],
          processTableAvailable: false,
        })),
        getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
        getTrackedRunId: vi.fn(() => RUN_ID),
        getAgentRuntimeSnapshotCacheTtlMs: vi.fn(() => 1_000),
        liveRuntimeMetadataCache: {
          rememberLiveTeamAgentRuntimeMetadata: vi.fn(),
        },
        logDebug: vi.fn(),
      });

      expect(metadata.get('Worker')).toMatchObject({
        alive: false,
        model: 'gpt-current',
        livenessKind: 'not_found',
        runtimeDiagnostic: 'runtime process not found',
      });
      expect(metadata.get('Worker')?.pid).toBeUndefined();
      expect(metadata.get('Worker')?.metricsPid).toBeUndefined();
      expect(metadata.get('Worker')?.runtimeSessionId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
