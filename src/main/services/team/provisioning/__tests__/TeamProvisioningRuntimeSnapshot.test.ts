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

function mixedRunWithConfirmedSecondaryEvidence(
  overrides: {
    laneMemberName?: string;
    laneRunId?: string | null;
    resultRunId?: string;
    evidenceKey?: string;
    evidenceMemberName?: string;
    omitEvidenceMemberName?: boolean;
    evidenceRuntimePid?: number;
  } = {}
): TeamProvisioningRuntimeSnapshotRun {
  const currentRun = run();
  const configuredMember = currentRun.request.members[0];
  const evidence = runtimeAdapterRun({
    runtimePid: overrides.evidenceRuntimePid,
  }).members?.Worker;
  if (!configuredMember || !evidence) {
    throw new Error('expected mixed secondary member fixture');
  }
  const member = {
    ...configuredMember,
    name: overrides.laneMemberName ?? configuredMember.name,
  };
  const laneRunId =
    overrides.laneRunId === undefined ? 'run-secondary-current' : overrides.laneRunId;
  const laneEvidence: Partial<typeof evidence> = {
    ...evidence,
    memberName: overrides.evidenceMemberName ?? evidence.memberName,
  };
  if (overrides.omitEvidenceMemberName) {
    delete laneEvidence.memberName;
  }
  currentRun.mixedSecondaryLanes = [
    {
      laneId: 'secondary:opencode:Worker',
      member,
      runId: laneRunId,
      result: {
        runId: overrides.resultRunId ?? 'run-secondary-current',
        members: {
          [overrides.evidenceKey ?? 'Worker']: laneEvidence as typeof evidence,
        },
      },
    },
  ];
  return currentRun;
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

function mixedRunWithPendingSharedHostEvidence(): TeamProvisioningRuntimeSnapshotRun {
  const currentRun = mixedRunWithConfirmedSecondaryEvidence();
  const laneEvidence = currentRun.mixedSecondaryLanes?.[0]?.result?.members?.Worker;
  if (!laneEvidence) {
    throw new Error('expected mixed secondary runtime evidence');
  }
  laneEvidence.launchState = 'runtime_pending_bootstrap';
  laneEvidence.bootstrapConfirmed = false;
  laneEvidence.livenessKind = 'runtime_process_candidate';
  laneEvidence.runtimeDiagnostic =
    'OpenCode runtime pid reported by bridge without local process verification';
  return currentRun;
}

function sharedOpenCodeHostProcessRows(): RuntimeTelemetryProcessTableRow[] {
  return [
    {
      pid: CURRENT_PID,
      ppid: 1,
      command: 'opencode serve --hostname 127.0.0.1 --port 62013',
    },
  ];
}

function confirmedCurrentSpawnStatus(): MemberSpawnStatusEntry {
  return {
    status: 'online',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    livenessKind: 'confirmed_bootstrap',
    updatedAt: UPDATED_AT,
  };
}

interface MixedRuntimeFixtureOptions {
  run?: TeamProvisioningRuntimeSnapshotRun;
  primaryRuntime?: RuntimeAdapterRunSnapshotSource;
  processRows?: RuntimeTelemetryProcessTableRow[];
  processTableAvailable?: boolean;
  spawnStatuses?: Record<string, MemberSpawnStatusEntry>;
  spawnStatusRunId?: string;
  spawnStatusSource?: MemberSpawnStatusesSnapshot['source'];
  advanceClockInSpawnStatusReadMs?: number;
}

async function buildMixedRuntimeMetadata(
  options: MixedRuntimeFixtureOptions
): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
  return buildLiveTeamAgentRuntimeMetadata({
    teamName: TEAM_NAME,
    runId: RUN_ID,
    generationAtStart: 0,
    runs: new Map([[RUN_ID, options.run ?? mixedRunWithConfirmedSecondaryEvidence()]]),
    runtimeAdapterRunByTeam: options.primaryRuntime
      ? new Map([[TEAM_NAME, options.primaryRuntime]])
      : new Map(),
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
    readPersistedRuntimeMembers: vi.fn(() => [] satisfies PersistedRuntimeMemberLike[]),
    readRuntimeProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
      rows: options.processRows ?? processRows(),
      processTableAvailable: options.processTableAvailable ?? true,
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
}

async function buildMixedRuntimeSnapshot(
  options: MixedRuntimeFixtureOptions
): Promise<Awaited<ReturnType<typeof buildTeamAgentRuntimeSnapshot>>> {
  const currentRun = options.run ?? mixedRunWithConfirmedSecondaryEvidence();
  const liveRuntimeByMember = await buildMixedRuntimeMetadata({
    ...options,
    run: currentRun,
  });
  return buildTeamAgentRuntimeSnapshot({
    teamName: TEAM_NAME,
    runId: RUN_ID,
    generationAtStart: 0,
    runs: new Map([[RUN_ID, currentRun]]),
    runtimeAdapterRunByTeam: options.primaryRuntime
      ? new Map([[TEAM_NAME, options.primaryRuntime]])
      : new Map(),
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
    readPersistedRuntimeMembers: vi.fn(() => [] satisfies PersistedRuntimeMemberLike[]),
    getMemberSpawnStatuses: vi.fn(async (): Promise<MemberSpawnStatusesSnapshot> => {
      if (options.advanceClockInSpawnStatusReadMs) {
        vi.setSystemTime(
          new Date(Date.parse(UPDATED_AT) + options.advanceClockInSpawnStatusReadMs)
        );
      }
      return {
        runId: options.spawnStatusRunId ?? RUN_ID,
        source: options.spawnStatusSource ?? 'live',
        statuses: options.spawnStatuses ?? {},
      };
    }),
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
}

function claudeConfig(): TeamConfig {
  return {
    name: TEAM_NAME,
    members: [
      {
        name: 'Worker',
        providerId: 'anthropic',
        model: 'claude-sonnet-4-6',
        cwd: WORKDIR,
      },
    ],
  };
}

function claudeRun(): TeamProvisioningRuntimeSnapshotRun {
  const member = {
    name: 'Worker',
    providerId: 'anthropic' as const,
    model: 'claude-sonnet-4-6',
    cwd: WORKDIR,
  };
  return {
    runId: RUN_ID,
    child: null,
    processKilled: false,
    cancelRequested: false,
    request: {
      teamName: TEAM_NAME,
      members: [member],
      cwd: WORKDIR,
      providerId: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    effectiveMembers: [member],
    allEffectiveMembers: [member],
    memberSpawnStatuses: new Map(),
  };
}

async function buildClaudeFinalSnapshot(params: {
  liveRuntime: LiveTeamAgentRuntimeMetadata;
  spawnStatus: MemberSpawnStatusEntry;
}) {
  return buildTeamAgentRuntimeSnapshot({
    teamName: TEAM_NAME,
    runId: RUN_ID,
    generationAtStart: 0,
    runs: new Map([[RUN_ID, claudeRun()]]),
    runtimeAdapterRunByTeam: new Map(),
    teamMetaStore: {
      getMeta: vi.fn(async () => ({ providerId: 'anthropic' as const })),
    },
    membersMetaStore: {
      getMembers: vi.fn(async () => []),
    },
    launchStateStore: {
      read: vi.fn(async () => null),
    },
    readConfigSnapshot: vi.fn(async () => claudeConfig()),
    readPersistedRuntimeMembers: vi.fn(() => []),
    getMemberSpawnStatuses: vi.fn(
      async (): Promise<MemberSpawnStatusesSnapshot> => ({
        runId: RUN_ID,
        source: 'live',
        statuses: { Worker: params.spawnStatus },
      })
    ),
    getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map([['Worker', params.liveRuntime]])),
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
}

describe('TeamProvisioningRuntimeSnapshot source precedence', () => {
  it('keeps future-dated registered-only live evidence conservative despite raw spawn confirmation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const futureHeartbeatAt = '2026-01-01T00:00:00.001Z';
      const snapshot = await buildClaudeFinalSnapshot({
        liveRuntime: {
          alive: false,
          backendType: 'process',
          providerId: 'anthropic',
          livenessKind: 'registered_only',
          pidSource: 'runtime_bootstrap',
          runtimeLastSeenAt: futureHeartbeatAt,
          runtimeDiagnostic: 'runtime heartbeat timestamp is in the future',
          runtimeDiagnosticSeverity: 'warning',
        },
        spawnStatus: {
          status: 'online',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastHeartbeatAt: futureHeartbeatAt,
          updatedAt: UPDATED_AT,
        },
      });

      expect(snapshot.members.Worker).toMatchObject({
        alive: false,
        livenessKind: 'registered_only',
        pidSource: 'runtime_bootstrap',
        runtimeLastSeenAt: futureHeartbeatAt,
        runtimeDiagnostic: 'runtime heartbeat timestamp is in the future',
        runtimeDiagnosticSeverity: 'warning',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains confirmed spawn fallback for a valid current heartbeat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const snapshot = await buildClaudeFinalSnapshot({
        liveRuntime: {
          alive: false,
          backendType: 'process',
          providerId: 'anthropic',
          livenessKind: 'registered_only',
          pidSource: 'persisted_metadata',
          runtimeLastSeenAt: UPDATED_AT,
          runtimeDiagnostic: 'registered runtime metadata without live process',
          runtimeDiagnosticSeverity: 'warning',
        },
        spawnStatus: {
          status: 'online',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastHeartbeatAt: UPDATED_AT,
          updatedAt: UPDATED_AT,
        },
      });

      expect(snapshot.members.Worker).toMatchObject({
        alive: true,
        livenessKind: 'confirmed_bootstrap',
        pidSource: 'runtime_bootstrap',
        runtimeLastSeenAt: UPDATED_AT,
        runtimeDiagnostic: 'bootstrap confirmed',
        runtimeDiagnosticSeverity: 'info',
      });
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('keeps runtime adapter permission evidence ahead of adapter bootstrap confirmation', async () => {
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
      const adapterRun = runtimeAdapterRun();
      const adapterMember = adapterRun.members?.Worker;
      if (!adapterMember) {
        throw new Error('expected runtime adapter member fixture');
      }
      adapterMember.launchState = 'runtime_pending_permission';
      adapterMember.pendingPermissionRequestIds = ['permission-1'];

      const snapshot = await buildTeamAgentRuntimeSnapshot({
        teamName: TEAM_NAME,
        runId: RUN_ID,
        generationAtStart: 0,
        runs: new Map([[RUN_ID, run()]]),
        runtimeAdapterRunByTeam: new Map([[TEAM_NAME, adapterRun]]),
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
        alive: false,
        livenessKind: 'permission_blocked',
        runtimeDiagnostic: 'waiting for permission approval',
        runtimeDiagnosticSeverity: 'warning',
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

  it('uses live exact mixed secondary evidence across case-only member variants', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const currentRun = mixedRunWithConfirmedSecondaryEvidence({
        laneMemberName: 'wOrKeR',
        evidenceKey: 'WORKER',
        evidenceMemberName: 'worker',
      });
      const metadata = await buildMixedRuntimeMetadata({ run: currentRun });
      const snapshot = await buildMixedRuntimeSnapshot({ run: currentRun });

      expect([...metadata.keys()]).toEqual(['Worker']);
      expect(metadata.get('Worker')).toMatchObject({
        alive: true,
        providerId: 'opencode',
        model: 'gpt-current',
        pid: CURRENT_PID,
        metricsPid: CURRENT_PID,
        pidSource: 'opencode_bridge',
        runtimeSessionId: 'session-current',
        runtimeDiagnostic: 'OpenCode runtime process detected after bootstrap confirmation',
      });
      expect(snapshot.members.Worker).toMatchObject({
        alive: true,
        laneId: 'secondary:opencode:Worker',
        laneKind: 'secondary',
        runtimeSessionId: 'session-current',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['live', 'merged'] as const)(
    'combines a verified shared OpenCode host candidate with current %s bootstrap truth',
    async (spawnStatusSource) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(UPDATED_AT));
      try {
        const snapshot = await buildMixedRuntimeSnapshot({
          run: mixedRunWithPendingSharedHostEvidence(),
          processRows: sharedOpenCodeHostProcessRows(),
          spawnStatusSource,
          advanceClockInSpawnStatusReadMs: 1,
          spawnStatuses: {
            Worker: {
              ...confirmedCurrentSpawnStatus(),
              lastHeartbeatAt: '2026-01-01T00:00:00.001Z',
              updatedAt: '2026-01-01T00:00:00.001Z',
            },
          },
        });

        expect(snapshot.members.Worker).toMatchObject({
          alive: true,
          livenessKind: 'confirmed_bootstrap',
          pidSource: 'opencode_bridge',
          runtimeSessionId: 'session-current',
          laneKind: 'secondary',
          historicalBootstrapConfirmed: true,
          runtimeDiagnostic: 'OpenCode bootstrap confirmed; runtime host/session evidence present.',
        });
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each([
    { label: 'persisted source', spawnStatusSource: 'persisted' as const },
    { label: 'mismatched run', spawnStatusSource: 'live' as const, spawnStatusRunId: OLD_RUN_ID },
  ])(
    'does not revive a shared OpenCode host candidate from $label bootstrap truth',
    async ({ spawnStatusSource, spawnStatusRunId }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(UPDATED_AT));
      try {
        const snapshot = await buildMixedRuntimeSnapshot({
          run: mixedRunWithPendingSharedHostEvidence(),
          processRows: sharedOpenCodeHostProcessRows(),
          spawnStatusSource,
          spawnStatusRunId,
          spawnStatuses: {
            Worker: confirmedCurrentSpawnStatus(),
          },
        });

        expect(snapshot.members.Worker).toMatchObject({
          alive: false,
          livenessKind: 'runtime_process_candidate',
          pidSource: 'opencode_bridge',
          runtimeSessionId: 'session-current',
          laneKind: 'secondary',
        });
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('reserves exact live runtime keys for their current candidate owner', async () => {
    const currentRun = run();
    const canonicalMember = currentRun.request.members[0];
    if (!canonicalMember) {
      throw new Error('expected canonical member fixture');
    }
    const suffixedMember = { ...canonicalMember, name: 'Worker-2' };
    currentRun.request.members = [canonicalMember, suffixedMember];
    currentRun.effectiveMembers = [canonicalMember, suffixedMember];
    currentRun.allEffectiveMembers = [canonicalMember, suffixedMember];

    const snapshot = await buildTeamAgentRuntimeSnapshot({
      teamName: TEAM_NAME,
      runId: RUN_ID,
      generationAtStart: 0,
      runs: new Map([[RUN_ID, currentRun]]),
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
      readConfigSnapshot: vi.fn(async () => ({
        ...config(),
        members: [canonicalMember, suffixedMember],
      })),
      readPersistedRuntimeMembers: vi.fn(() => []),
      getMemberSpawnStatuses: vi.fn(
        async (): Promise<MemberSpawnStatusesSnapshot> => ({
          runId: RUN_ID,
          source: 'live',
          statuses: {},
        })
      ),
      getLiveTeamAgentRuntimeMetadata: vi.fn(
        async () =>
          new Map<string, LiveTeamAgentRuntimeMetadata>([
            [
              'Worker-2',
              {
                alive: true,
                backendType: 'process',
                providerId: 'opencode',
                model: 'gpt-current',
                pid: CURRENT_PID,
                runtimeSessionId: 'session-worker-2',
                livenessKind: 'runtime_process',
                pidSource: 'opencode_bridge',
              },
            ],
          ])
      ),
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

    expect(snapshot.members.Worker).toMatchObject({ alive: false });
    expect(snapshot.members.Worker?.pid).toBeUndefined();
    expect(snapshot.members.Worker?.runtimeSessionId).toBeUndefined();
    expect(snapshot.members['Worker-2']).toMatchObject({
      alive: true,
      pid: CURRENT_PID,
      runtimeSessionId: 'session-worker-2',
      livenessKind: 'runtime_process',
    });
  });

  it('accepts legacy exact-key evidence without an embedded member name', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const currentRun = mixedRunWithConfirmedSecondaryEvidence({
        omitEvidenceMemberName: true,
      });
      const metadata = await buildMixedRuntimeMetadata({ run: currentRun });
      const snapshot = await buildMixedRuntimeSnapshot({ run: currentRun });

      expect(metadata.get('Worker')).toMatchObject({
        alive: true,
        runtimeSessionId: 'session-current',
      });
      expect(snapshot.members.Worker).toMatchObject({
        alive: true,
        runtimeSessionId: 'session-current',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects exact-key evidence with a conflicting embedded member name', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const currentRun = mixedRunWithConfirmedSecondaryEvidence({
        evidenceMemberName: 'Worker2',
      });
      const metadata = await buildMixedRuntimeMetadata({ run: currentRun });
      const snapshot = await buildMixedRuntimeSnapshot({ run: currentRun });

      expect(metadata.get('Worker')).toMatchObject({ alive: false });
      expect(metadata.get('Worker')?.runtimeSessionId).toBeUndefined();
      expect(snapshot.members.Worker).toMatchObject({ alive: false });
      expect(snapshot.members.Worker?.runtimeSessionId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not rejoin sibling suffix evidence to an exact mixed secondary owner', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const currentRun = mixedRunWithConfirmedSecondaryEvidence({
        evidenceKey: 'Worker2',
        evidenceMemberName: 'Worker2',
      });
      const metadata = await buildMixedRuntimeMetadata({ run: currentRun });
      const snapshot = await buildMixedRuntimeSnapshot({ run: currentRun });

      expect(metadata.get('Worker')).toMatchObject({
        alive: false,
        livenessKind: 'registered_only',
        runtimeDiagnostic: 'registered runtime metadata without live process',
      });
      expect(metadata.get('Worker')?.metricsPid).toBeUndefined();
      expect(metadata.get('Worker')?.runtimeSessionId).toBeUndefined();
      expect(snapshot.members.Worker).toMatchObject({
        alive: false,
        laneKind: 'secondary',
      });
      expect(snapshot.members.Worker?.runtimeSessionId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets stale exact mixed lane evidence suppress current primary evidence for that owner', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const currentRun = mixedRunWithConfirmedSecondaryEvidence({ resultRunId: OLD_RUN_ID });
      const metadata = await buildMixedRuntimeMetadata({
        run: currentRun,
        primaryRuntime: runtimeAdapterRun(),
        processRows: [],
      });
      const snapshot = await buildMixedRuntimeSnapshot({
        run: currentRun,
        primaryRuntime: runtimeAdapterRun(),
        processRows: [],
      });

      expect(metadata.get('Worker')).toMatchObject({
        alive: false,
        livenessKind: 'registered_only',
        runtimeDiagnostic: 'registered runtime metadata without live process',
      });
      expect(metadata.get('Worker')?.metricsPid).toBeUndefined();
      expect(metadata.get('Worker')?.runtimeSessionId).toBeUndefined();
      expect(snapshot.members.Worker).toMatchObject({
        alive: false,
        laneKind: 'secondary',
      });
      expect(snapshot.members.Worker?.runtimeSessionId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      probe: 'dead',
      processTableAvailable: true,
      livenessKind: 'stale_metadata',
      runtimeDiagnostic: 'persisted runtime pid is not alive',
    },
    {
      probe: 'unknown',
      processTableAvailable: false,
      livenessKind: 'registered_only',
      runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
    },
  ])(
    'does not revive exact mixed secondary evidence when its runtime probe is $probe',
    async ({ processTableAvailable, livenessKind, runtimeDiagnostic }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(UPDATED_AT));
      try {
        const metadata = await buildMixedRuntimeMetadata({
          processRows: [],
          processTableAvailable,
        });
        const snapshot = await buildMixedRuntimeSnapshot({
          processRows: [],
          processTableAvailable,
        });

        expect(metadata.get('Worker')).toMatchObject({
          alive: false,
          livenessKind,
          runtimeDiagnostic,
          runtimeSessionId: 'session-current',
        });
        expect(snapshot.members.Worker).toMatchObject({
          alive: false,
          livenessKind,
          runtimeDiagnostic,
          runtimeSessionId: 'session-current',
          laneKind: 'secondary',
        });
      } finally {
        vi.useRealTimers();
      }
    }
  );

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
