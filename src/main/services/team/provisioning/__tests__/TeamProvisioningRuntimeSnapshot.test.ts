import { describe, expect, it, vi } from 'vitest';

import {
  buildLiveTeamAgentRuntimeMetadata,
  buildTeamAgentRuntimeSnapshot,
  findLiveOpenCodeLaneHostRow,
  isOpenCodeLaneHostOverridableLiveness,
  type PersistedRuntimeMemberLike,
  shouldReadWindowsHostRowsForMemberLane,
} from '../TeamProvisioningRuntimeSnapshot';

import type { RuntimeTelemetryProcessTableRow } from '../../TeamRuntimeTelemetry';
import type { LiveTeamAgentRuntimeMetadata } from '../TeamProvisioningRuntimeMetadataPolicy';
import type {
  RuntimeAdapterRunSnapshotSource,
  TeamProvisioningRuntimeSnapshotRun,
} from '../TeamProvisioningRuntimeSnapshotTypes';
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
const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  });
}

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

/**
 * A lane whose bootstrap evidence is the persisted launch snapshot and whose
 * heartbeat has aged out. Without `runtimeAdapterRunByTeam` there is no
 * provisioning run in flight either, which is the owner-'none' case.
 */
async function buildPersistedLaneRuntimeMetadata(options: {
  processRows: RuntimeTelemetryProcessTableRow[];
  readWindowsHostProcessRows: ReturnType<typeof vi.fn>;
  runtimeAdapterRunByTeam?: ReadonlyMap<string, RuntimeAdapterRunSnapshotSource>;
}): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
  return buildLiveTeamAgentRuntimeMetadata({
    teamName: TEAM_NAME,
    runId: RUN_ID,
    generationAtStart: 0,
    runs: new Map([[RUN_ID, run()]]),
    runtimeAdapterRunByTeam: options.runtimeAdapterRunByTeam ?? new Map(),
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
          })
        )
      ),
    },
    readConfigSnapshot: vi.fn(async () => config()),
    readPersistedRuntimeMembers: vi.fn(() => [] satisfies PersistedRuntimeMemberLike[]),
    readRuntimeProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
      rows: options.processRows,
      processTableAvailable: true,
    })),
    readWindowsHostProcessRowsForLiveRuntimeMetadata: options.readWindowsHostProcessRows,
    getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
    getTrackedRunId: vi.fn(() => RUN_ID),
    getAgentRuntimeSnapshotCacheTtlMs: vi.fn(() => 1_000),
    liveRuntimeMetadataCache: {
      rememberLiveTeamAgentRuntimeMetadata: vi.fn(),
    },
    logDebug: vi.fn(),
  });
}

interface LaneLivenessVerdict {
  hostRowsRead: boolean;
  verdict: { alive: boolean | undefined; livenessKind: string | undefined };
}

/**
 * The same lane resolved on both sides of the win32 seam. On win32 the lane
 * host rows reach the resolver through the Windows host table
 * (`shouldReadWindowsHostRowsForMemberLane`), everywhere else through the
 * shared process table - the verdict has to come out the same either way.
 */
async function resolveLaneLivenessOnBothPlatforms(options: {
  runtimeAdapterRunByTeam?: ReadonlyMap<string, RuntimeAdapterRunSnapshotSource>;
}): Promise<Record<'linux' | 'win32', LaneLivenessVerdict>> {
  const byPlatform = new Map<'linux' | 'win32', LaneLivenessVerdict>();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.parse(UPDATED_AT) + 5 * 60_000));
  try {
    for (const platform of ['linux', 'win32'] as const) {
      setPlatform(platform);
      const isWin32 = platform === 'win32';
      const readWindowsHostProcessRows = vi.fn(async () => ({
        rows: isWin32 ? sharedOpenCodeHostProcessRows() : [],
        processTableAvailable: isWin32,
      }));
      const metadata = await buildPersistedLaneRuntimeMetadata({
        processRows: isWin32 ? [] : sharedOpenCodeHostProcessRows(),
        readWindowsHostProcessRows,
        runtimeAdapterRunByTeam: options.runtimeAdapterRunByTeam,
      });
      const worker = metadata.get('Worker');
      byPlatform.set(platform, {
        hostRowsRead: readWindowsHostProcessRows.mock.calls.length > 0,
        verdict: { alive: worker?.alive, livenessKind: worker?.livenessKind },
      });
    }
  } finally {
    setPlatform(ORIGINAL_PLATFORM);
    vi.useRealTimers();
  }
  const linux = byPlatform.get('linux');
  const win32 = byPlatform.get('win32');
  if (!linux || !win32) {
    throw new Error('expected a lane verdict on both platforms');
  }
  return { linux, win32 };
}

/**
 * The same owned win32 lane with its live `opencode serve` row placed in one
 * process table or the other. On win32 the shared table is WSL's `ps`, whose
 * pids are numbered independently of the recorded Windows host pid, so which
 * table a row arrives in decides whether its pid means anything for this lane.
 */
async function resolveWin32LaneLivenessByTable(options: {
  hostRows: RuntimeTelemetryProcessTableRow[];
  sharedRows: RuntimeTelemetryProcessTableRow[];
}): Promise<{ alive: boolean | undefined; livenessKind: string | undefined }> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.parse(UPDATED_AT) + 5 * 60_000));
  setPlatform('win32');
  try {
    const metadata = await buildPersistedLaneRuntimeMetadata({
      processRows: options.sharedRows,
      readWindowsHostProcessRows: vi.fn(async () => ({
        rows: options.hostRows,
        processTableAvailable: true,
      })),
      runtimeAdapterRunByTeam: new Map([
        [TEAM_NAME, { runId: RUN_ID, providerId: 'opencode', cwd: WORKDIR, members: {} }],
      ]),
    });
    const worker = metadata.get('Worker');
    return { alive: worker?.alive, livenessKind: worker?.livenessKind };
  } finally {
    setPlatform(ORIGINAL_PLATFORM);
    vi.useRealTimers();
  }
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

      // Ephemeral lane hosts: persisted/registered metadata keeps the member alive between turns.
      expect(metadata.get('Worker')).toMatchObject({ alive: true });
      expect(metadata.get('Worker')?.runtimeSessionId).toBeUndefined();
      expect(snapshot.members.Worker).toMatchObject({ alive: true });
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
        alive: true,
        livenessKind: 'registered_only',
        runtimeDiagnostic: 'registered runtime metadata without live process',
      });
      expect(metadata.get('Worker')?.metricsPid).toBeUndefined();
      expect(metadata.get('Worker')?.runtimeSessionId).toBeUndefined();
      expect(snapshot.members.Worker).toMatchObject({
        alive: true,
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
        alive: true,
        livenessKind: 'registered_only',
        runtimeDiagnostic: 'registered runtime metadata without live process',
      });
      expect(metadata.get('Worker')?.metricsPid).toBeUndefined();
      expect(metadata.get('Worker')?.runtimeSessionId).toBeUndefined();
      expect(snapshot.members.Worker).toMatchObject({
        alive: true,
        laneKind: 'secondary',
      });
      expect(snapshot.members.Worker?.runtimeSessionId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // The two halves of the asymmetry, side by side: a table that answered is
  // evidence, a table that could not answer is not.
  it('does not revive exact mixed secondary evidence when the process table answered without its runtime pid', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const metadata = await buildMixedRuntimeMetadata({
        processRows: [],
        processTableAvailable: true,
      });
      const snapshot = await buildMixedRuntimeSnapshot({
        processRows: [],
        processTableAvailable: true,
      });

      expect(metadata.get('Worker')).toMatchObject({
        alive: false,
        livenessKind: 'stale_metadata',
        runtimeDiagnostic: 'persisted runtime pid is not alive',
        runtimeSessionId: 'session-current',
      });
      expect(snapshot.members.Worker).toMatchObject({
        alive: false,
        livenessKind: 'stale_metadata',
        runtimeDiagnostic: 'persisted runtime pid is not alive',
        runtimeSessionId: 'session-current',
        laneKind: 'secondary',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps exact mixed secondary evidence deliverable when the process table could not answer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
    try {
      const metadata = await buildMixedRuntimeMetadata({
        processRows: [],
        processTableAvailable: false,
      });
      const snapshot = await buildMixedRuntimeSnapshot({
        processRows: [],
        processTableAvailable: false,
      });

      expect(metadata.get('Worker')).toMatchObject({
        alive: true,
        livenessKind: 'registered_only',
        runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
        runtimeSessionId: 'session-current',
      });
      expect(snapshot.members.Worker).toMatchObject({
        alive: true,
        livenessKind: 'registered_only',
        runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
        runtimeSessionId: 'session-current',
        laneKind: 'secondary',
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

  // With no provisioning run in flight the recorded pid is the only thing
  // tying the member to a process row, and a pid the OS may have reassigned is
  // too weak to promote a card back to alive - equally weak whether the row
  // arrives through the win32 host table or the shared process table. Running
  // the same lane through both values of the platform seam is what keeps that
  // one rule from silently becoming two.
  it('leaves an unowned OpenCode lane unpromoted, identically on win32 and off it', async () => {
    const { linux, win32 } = await resolveLaneLivenessOnBothPlatforms({});

    expect(win32.hostRowsRead).toBe(true);
    expect(linux.hostRowsRead).toBe(false);
    expect(win32.verdict).toEqual(linux.verdict);
    expect(linux.verdict).toEqual({
      alive: false,
      livenessKind: 'runtime_process_candidate',
    });
  });

  // The other side of the same rule: a lane a run in flight owns is verified
  // against its live serve host, and that verdict is platform-independent too.
  // Without this case the rule above would also be satisfied by never
  // promoting anything.
  it('revives an owned OpenCode lane from its live serve host, identically on win32 and off it', async () => {
    const { linux, win32 } = await resolveLaneLivenessOnBothPlatforms({
      runtimeAdapterRunByTeam: new Map([
        [TEAM_NAME, { runId: RUN_ID, providerId: 'opencode', cwd: WORKDIR, members: {} }],
      ]),
    });

    expect(win32.hostRowsRead).toBe(true);
    expect(linux.hostRowsRead).toBe(false);
    expect(win32.verdict).toEqual(linux.verdict);
    expect(linux.verdict).toEqual({
      alive: true,
      livenessKind: 'runtime_process',
    });
  });

  // On win32 the shared rows are WSL's `ps` output, numbered independently of
  // the recorded Windows host pid, so an unrelated WSL `opencode serve` can
  // carry that same pid. Only the Windows host table answers for it - and the
  // second half keeps that from being satisfied by never promoting anything.
  it('does not revive a win32 lane from a colliding serve row in the WSL table', async () => {
    const collidingWslServeHost = await resolveWin32LaneLivenessByTable({
      hostRows: [
        {
          pid: CURRENT_PID + 1,
          ppid: 1,
          command: 'opencode serve --hostname 127.0.0.1 --port 62014',
        },
      ],
      sharedRows: sharedOpenCodeHostProcessRows(),
    });
    const ownWindowsHost = await resolveWin32LaneLivenessByTable({
      hostRows: sharedOpenCodeHostProcessRows(),
      sharedRows: [],
    });

    expect(collidingWslServeHost).toEqual({
      alive: false,
      livenessKind: 'runtime_process_candidate',
    });
    expect(ownWindowsHost).toEqual({ alive: true, livenessKind: 'runtime_process' });
  });

  // The pid is only worthless across that boundary while nothing else ties the
  // row to this lane: a WSL row whose command names this team and this member
  // identifies itself, so a member launched inside WSL keeps its evidence.
  it('still revives a win32 lane from a WSL row flagged for this team and member', async () => {
    const verdict = await resolveWin32LaneLivenessByTable({
      hostRows: [],
      sharedRows: [
        {
          pid: CURRENT_PID,
          ppid: 1,
          command: `opencode run --team-name ${TEAM_NAME} --agent-id Worker`,
        },
      ],
    });

    expect(verdict).toEqual({ alive: true, livenessKind: 'runtime_process' });
  });
});

describe('findLiveOpenCodeLaneHostRow', () => {
  const rows: RuntimeTelemetryProcessTableRow[] = [
    {
      pid: 31276,
      ppid: 39012,
      command:
        'C:/ProgramData/agent-teams-ai/runtimes/opencode/opencode.exe serve --hostname 127.0.0.1 --port 65122',
    },
    { pid: 4242, ppid: 1, command: 'node something-else.js' },
    {
      pid: 5151,
      ppid: 39012,
      command:
        'C:/ProgramData/agent-teams-ai/runtimes/opencode/opencode.exe run --team-name other --agent-id nobody',
    },
  ];

  it('matches the serve host by the recorded wrapper pid (parent) or by its own pid', () => {
    expect(
      findLiveOpenCodeLaneHostRow({
        runtimePid: 39012,
        teamName: TEAM_NAME,
        memberName: 'Worker',
        processRows: rows,
        processTableAvailable: true,
      })?.pid
    ).toBe(31276);
    expect(
      findLiveOpenCodeLaneHostRow({
        runtimePid: 31276,
        teamName: TEAM_NAME,
        memberName: 'Worker',
        processRows: rows,
        processTableAvailable: true,
      })?.pid
    ).toBe(31276);
  });

  it('returns null without a pid, without the process table, or for unrelated processes', () => {
    expect(
      findLiveOpenCodeLaneHostRow({
        runtimePid: null,
        teamName: TEAM_NAME,
        memberName: 'Worker',
        processRows: rows,
        processTableAvailable: true,
      })
    ).toBeNull();
    expect(
      findLiveOpenCodeLaneHostRow({
        runtimePid: 39012,
        teamName: TEAM_NAME,
        memberName: 'Worker',
        processRows: rows,
        processTableAvailable: false,
      })
    ).toBeNull();
    expect(
      findLiveOpenCodeLaneHostRow({
        runtimePid: 4242,
        teamName: TEAM_NAME,
        memberName: 'Worker',
        processRows: rows,
        processTableAvailable: true,
      })
    ).toBeNull();
    // A flagged opencode process for another member is not this lane's host.
    expect(
      findLiveOpenCodeLaneHostRow({
        runtimePid: 5151,
        teamName: TEAM_NAME,
        memberName: 'Worker',
        processRows: rows,
        processTableAvailable: true,
      })
    ).toBeNull();
  });

  // Negative control: 'opencode' in the command line is not on its own a lane
  // host. Without `serve` the row has to name this team and this member.
  it('does not match an opencode process that is neither a serve host nor flagged for this lane', () => {
    expect(
      findLiveOpenCodeLaneHostRow({
        runtimePid: 7777,
        teamName: TEAM_NAME,
        memberName: 'Worker',
        processRows: [{ pid: 7777, ppid: 1, command: 'opencode auth login' }],
        processTableAvailable: true,
      })
    ).toBeNull();
    expect(
      findLiveOpenCodeLaneHostRow({
        runtimePid: 7777,
        teamName: TEAM_NAME,
        memberName: 'Worker',
        processRows: [
          {
            pid: 7777,
            ppid: 1,
            command: `opencode run --team-name ${TEAM_NAME} --agent-id Worker`,
          },
        ],
        processTableAvailable: true,
      })?.pid
    ).toBe(7777);
  });

  // Rows from a table that does not share the recorded pid's namespace reach
  // the matcher separately: their pid can collide with an unrelated serve host,
  // so only the lane's own --team-name/--agent-id flags may match there.
  it('takes a bare pid match from the recorded namespace only', () => {
    const serveRow: RuntimeTelemetryProcessTableRow = {
      pid: 31276,
      ppid: 39012,
      command: 'opencode serve --hostname 127.0.0.1 --port 65122',
    };
    expect(
      findLiveOpenCodeLaneHostRow({
        runtimePid: 39012,
        teamName: TEAM_NAME,
        memberName: 'Worker',
        processRows: [],
        foreignPidNamespaceRows: [serveRow],
        processTableAvailable: true,
      })
    ).toBeNull();
    expect(
      findLiveOpenCodeLaneHostRow({
        runtimePid: 39012,
        teamName: TEAM_NAME,
        memberName: 'Worker',
        processRows: [serveRow],
        processTableAvailable: true,
      })?.pid
    ).toBe(31276);
    expect(
      findLiveOpenCodeLaneHostRow({
        runtimePid: 7777,
        teamName: TEAM_NAME,
        memberName: 'Worker',
        processRows: [],
        foreignPidNamespaceRows: [
          {
            pid: 7777,
            ppid: 1,
            command: `opencode run --team-name ${TEAM_NAME} --agent-id Worker`,
          },
        ],
        processTableAvailable: true,
      })?.pid
    ).toBe(7777);
  });
});

describe('isOpenCodeLaneHostOverridableLiveness', () => {
  it.each(['registered_only', 'stale_metadata', 'not_found', 'runtime_process_candidate'] as const)(
    'overrides %s, which was reached without seeing a process',
    (livenessKind) => {
      expect(isOpenCodeLaneHostOverridableLiveness(livenessKind)).toBe(true);
    }
  );

  it('overrides an absent liveness kind', () => {
    expect(isOpenCodeLaneHostOverridableLiveness(undefined)).toBe(true);
  });

  // Negative control: runtime_process already found a process and shell_only
  // says the pane holds no agent - a lane host must not overwrite either.
  it.each(['runtime_process', 'shell_only'] as const)('does not override %s', (livenessKind) => {
    expect(isOpenCodeLaneHostOverridableLiveness(livenessKind)).toBe(false);
  });
});

describe('shouldReadWindowsHostRowsForMemberLane', () => {
  const laneDefaults = {
    isOpenCodeLaneMember: true,
    backendType: 'process' as const,
    evidenceOwner: 'primary' as const,
    recordedRuntimePid: CURRENT_PID,
    adapterRuntimeAlive: undefined,
    adapterBootstrapConfirmed: undefined,
  };

  it.each(['primary', 'secondary', 'none'] as const)(
    'reads the Windows host table for a win32 OpenCode lane owned by %s',
    (evidenceOwner) => {
      expect(
        shouldReadWindowsHostRowsForMemberLane({
          ...laneDefaults,
          platform: 'win32',
          evidenceOwner,
        })
      ).toBe(true);
    }
  );

  // Negative control: the whole rule is win32-only, and this is the assertion
  // that says so from a test run on any platform.
  it.each(['primary', 'secondary', 'none'] as const)(
    'never reads the Windows host table off win32, owner %s',
    (evidenceOwner) => {
      expect(
        shouldReadWindowsHostRowsForMemberLane({
          ...laneDefaults,
          platform: 'linux',
          evidenceOwner,
        })
      ).toBe(false);
    }
  );

  it('does not read the host table for an unowned lane with no recorded pid', () => {
    expect(
      shouldReadWindowsHostRowsForMemberLane({
        ...laneDefaults,
        platform: 'win32',
        evidenceOwner: 'none',
        recordedRuntimePid: undefined,
      })
    ).toBe(false);
  });

  it('does not read the host table for a primary lane the adapter already reports live', () => {
    expect(
      shouldReadWindowsHostRowsForMemberLane({
        ...laneDefaults,
        platform: 'win32',
        adapterRuntimeAlive: true,
      })
    ).toBe(false);
    expect(
      shouldReadWindowsHostRowsForMemberLane({
        ...laneDefaults,
        platform: 'win32',
        adapterBootstrapConfirmed: true,
      })
    ).toBe(false);
  });

  it('still reads the host table for a secondary lane the adapter reports live', () => {
    expect(
      shouldReadWindowsHostRowsForMemberLane({
        ...laneDefaults,
        platform: 'win32',
        evidenceOwner: 'secondary',
        adapterRuntimeAlive: true,
        adapterBootstrapConfirmed: true,
      })
    ).toBe(true);
  });

  it('does not read the host table for a tmux-backed member that is not an OpenCode lane', () => {
    expect(
      shouldReadWindowsHostRowsForMemberLane({
        ...laneDefaults,
        platform: 'win32',
        isOpenCodeLaneMember: false,
        backendType: 'tmux',
      })
    ).toBe(false);
  });
});
