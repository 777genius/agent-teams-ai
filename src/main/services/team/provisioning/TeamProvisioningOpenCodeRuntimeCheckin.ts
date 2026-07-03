import { isLeadMember } from '@shared/utils/leadDetection';

import { getOpenCodeRuntimeRunTombstonesPath } from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  createRuntimeRunTombstoneStore,
  type RuntimeEvidenceKind,
  RuntimeStaleEvidenceError,
} from '../opencode/store/RuntimeRunTombstoneStore';
import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

import { getPersistedLaunchMemberNames } from './TeamProvisioningLaunchStateProjection';
import { matchesTeamMemberIdentity } from './TeamProvisioningMemberIdentity';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';
import { resolveEffectiveConfiguredMember } from './TeamProvisioningMemberStatusProjection';
import {
  commitOpenCodeRuntimeBootstrapSessionEvidence,
  hasCommittedOpenCodeRuntimeBootstrapSessionEvidence,
  type OpenCodeRuntimeBootstrapCheckinIdempotencyResult,
  type OpenCodeRuntimeBootstrapEvidencePorts,
  resolveOpenCodeRuntimeBootstrapCheckinIdempotencyFromMember,
} from './TeamProvisioningOpenCodeBootstrapEvidence';
import { summarizeRuntimeLaunchResultMembers } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange } from './TeamProvisioningOpenCodeRuntimeLivenessPolicy';
import { resolvePersistedRuntimeMemberIdentity } from './TeamProvisioningPersistedRuntimeMemberIdentity';
import {
  asRuntimeRecord,
  buildRuntimeToolMetadataDiagnostics,
  mergeRuntimeDiagnostics,
  normalizeRuntimeIso,
  normalizeRuntimeStringArray,
  optionalRuntimeString,
  parseRuntimeToolMetadata,
  requireRuntimeString,
  type RuntimeToolMetadata,
} from './TeamProvisioningRuntimeMetadata';

import type { TeamRuntimeLaunchResult, TeamRuntimeMemberLaunchEvidence } from '../runtime';
import type {
  OpenCodeTaskLogAttributionRecord,
  OpenCodeTaskLogAttributionWriteResult,
} from '../taskLogs/stream/OpenCodeTaskLogAttributionStore';
import type { PersistedRuntimeMemberLike } from './TeamProvisioningRuntimeSnapshot';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamChangeEvent,
  TeamConfig,
  TeamCreateRequest,
  TeamMember,
} from '@shared/types';

export interface OpenCodeRuntimeControlAck {
  ok: true;
  providerId: 'opencode';
  teamName: string;
  runId: string;
  state: 'accepted' | 'delivered' | 'duplicate' | 'recorded';
  memberName?: string;
  runtimeSessionId?: string;
  idempotencyKey?: string;
  location?: unknown;
  diagnostics: string[];
  observedAt: string;
}

export interface OpenCodeRuntimeCheckinLane {
  laneId: string;
  providerId: 'opencode';
  member: TeamCreateRequest['members'][number];
  runId: string | null;
  state: 'queued' | 'launching' | 'finished';
  result: TeamRuntimeLaunchResult | null;
  warnings: string[];
  diagnostics: string[];
}

export interface OpenCodeRuntimeCheckinRun {
  runId: string;
  teamName: string;
  request: TeamCreateRequest;
  effectiveMembers: TeamCreateRequest['members'];
  processKilled: boolean;
  cancelRequested: boolean;
  mixedSecondaryLanes: OpenCodeRuntimeCheckinLane[];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  pendingMemberRestarts?: Pick<Map<string, unknown>, 'delete' | 'has'>;
}

export interface OpenCodeRuntimeCheckinPorts<Run extends OpenCodeRuntimeCheckinRun> {
  teamsBasePath: string;
  resolveOpenCodeRuntimeLaneId(input: {
    teamName: string;
    runId: string;
    memberName?: string;
  }): Promise<string>;
  resolveCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): Promise<string | null>;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  writeLaunchState(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void>;
  readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null>;
  readMetaMembers(teamName: string): Promise<TeamMember[]>;
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  getTrackedRun(teamName: string): Run | null;
  persistTrackedRunLaunchState(run: Run): Promise<void>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  emitMemberSpawnChange(run: Run, memberName: string): void;
  emitRuntimeMemberSpawnChange(input: {
    teamName: string;
    runId: string;
    memberName: string;
  }): void;
  emitTaskLogChange(input: {
    teamName: string;
    runId: string;
    taskId: string;
    detail: string;
  }): void;
  createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts;
  upsertOpenCodeTaskRecord(
    teamName: string,
    record: OpenCodeTaskLogAttributionRecord
  ): Promise<OpenCodeTaskLogAttributionWriteResult>;
  syncMemberTaskActivityForRuntimeTransition(
    run: Run,
    memberName: string,
    previousStatus: MemberSpawnStatusEntry,
    nextStatus: MemberSpawnStatusEntry,
    observedAt: string
  ): void;
  syncMemberLaunchGraceCheck(
    run: Run,
    memberName: string,
    nextStatus: MemberSpawnStatusEntry
  ): void;
}

export type OpenCodeRuntimeCheckinPortCallbacks<Run extends OpenCodeRuntimeCheckinRun> = Omit<
  OpenCodeRuntimeCheckinPorts<Run>,
  'emitRuntimeMemberSpawnChange' | 'emitTaskLogChange'
> & {
  emitTeamChange(event: TeamChangeEvent): void;
};

export function createOpenCodeRuntimeCheckinPorts<Run extends OpenCodeRuntimeCheckinRun>(
  callbacks: OpenCodeRuntimeCheckinPortCallbacks<Run>
): OpenCodeRuntimeCheckinPorts<Run> {
  return {
    teamsBasePath: callbacks.teamsBasePath,
    resolveOpenCodeRuntimeLaneId: callbacks.resolveOpenCodeRuntimeLaneId,
    resolveCurrentOpenCodeRuntimeRunId: callbacks.resolveCurrentOpenCodeRuntimeRunId,
    readLaunchState: callbacks.readLaunchState,
    writeLaunchState: callbacks.writeLaunchState,
    readConfigForStrictDecision: callbacks.readConfigForStrictDecision,
    readMetaMembers: callbacks.readMetaMembers,
    readPersistedRuntimeMembers: callbacks.readPersistedRuntimeMembers,
    getTrackedRun: callbacks.getTrackedRun,
    persistTrackedRunLaunchState: callbacks.persistTrackedRunLaunchState,
    invalidateRuntimeSnapshotCaches: callbacks.invalidateRuntimeSnapshotCaches,
    emitMemberSpawnChange: callbacks.emitMemberSpawnChange,
    emitRuntimeMemberSpawnChange: (event) => {
      callbacks.emitTeamChange({
        type: 'member-spawn',
        teamName: event.teamName,
        runId: event.runId,
        detail: event.memberName,
      });
    },
    emitTaskLogChange: (event) => {
      callbacks.emitTeamChange({
        type: 'task-log-change',
        teamName: event.teamName,
        runId: event.runId,
        taskId: event.taskId,
        detail: event.detail,
        taskSignalKind: 'log',
      });
    },
    createOpenCodeRuntimeBootstrapEvidencePorts:
      callbacks.createOpenCodeRuntimeBootstrapEvidencePorts,
    upsertOpenCodeTaskRecord: callbacks.upsertOpenCodeTaskRecord,
    syncMemberTaskActivityForRuntimeTransition:
      callbacks.syncMemberTaskActivityForRuntimeTransition,
    syncMemberLaunchGraceCheck: callbacks.syncMemberLaunchGraceCheck,
  };
}

interface OpenCodeRuntimeLivenessInput {
  teamName: string;
  runId: string;
  memberName: string;
  runtimeSessionId: string;
  observedAt: string;
  diagnostics: unknown;
  metadata?: RuntimeToolMetadata;
  reason: string;
}

export async function recordOpenCodeRuntimeBootstrapCheckin<Run extends OpenCodeRuntimeCheckinRun>(
  raw: unknown,
  ports: OpenCodeRuntimeCheckinPorts<Run>
): Promise<OpenCodeRuntimeControlAck> {
  const payload = asRuntimeRecord(raw);
  const teamName = requireRuntimeString(payload.teamName, 'teamName');
  const runId = requireRuntimeString(payload.runId, 'runId');
  const memberName = requireRuntimeString(payload.memberName, 'memberName');
  const runtimeSessionId = requireRuntimeString(payload.runtimeSessionId, 'runtimeSessionId');
  const observedAt = normalizeRuntimeIso(payload.observedAt);
  const laneId = await ports.resolveOpenCodeRuntimeLaneId({ teamName, runId, memberName });

  await assertOpenCodeRuntimeEvidenceAccepted(
    {
      teamName,
      runId,
      laneId,
      evidenceKind: 'bootstrap_checkin',
    },
    ports
  );
  const idempotent = await resolveOpenCodeRuntimeBootstrapCheckinIdempotency(
    {
      teamName,
      runId,
      memberName,
      runtimeSessionId,
    },
    ports
  );
  const bootstrapEvidencePorts = ports.createOpenCodeRuntimeBootstrapEvidencePorts();
  await assertOpenCodeRuntimeMemberCheckinAllowed(
    {
      teamName,
      memberName,
      previousMember: idempotent.previousMember,
    },
    ports
  );
  if (idempotent.state === 'duplicate') {
    const committed = await hasCommittedOpenCodeRuntimeBootstrapSessionEvidence(
      {
        teamName,
        runId,
        laneId,
        memberName,
        runtimeSessionId,
      },
      bootstrapEvidencePorts
    );
    if (!committed) {
      await commitOpenCodeRuntimeBootstrapSessionEvidence(
        {
          teamName,
          runId,
          laneId,
          memberName,
          runtimeSessionId,
          observedAt,
        },
        bootstrapEvidencePorts
      );
    }
    await updateOpenCodeRuntimeMemberLiveness(
      {
        teamName,
        runId,
        memberName,
        runtimeSessionId,
        observedAt,
        diagnostics: payload.diagnostics,
        metadata: parseRuntimeToolMetadata(payload.metadata),
        reason: 'OpenCode runtime bootstrap check-in accepted',
      },
      ports
    );
    return {
      ok: true,
      providerId: 'opencode',
      teamName,
      runId,
      state: 'accepted',
      memberName,
      runtimeSessionId,
      diagnostics: ['opencode_bootstrap_checkin_duplicate_accepted'],
      observedAt,
    };
  }
  if (idempotent.state === 'conflict') {
    throw new RuntimeStaleEvidenceError(
      `opencode_bootstrap_checkin_session_conflict: existing runtime session ${idempotent.existingRuntimeSessionId}, received ${runtimeSessionId} for ${memberName}`,
      'run_mismatch',
      'bootstrap_checkin',
      runId
    );
  }
  await commitOpenCodeRuntimeBootstrapSessionEvidence(
    {
      teamName,
      runId,
      laneId,
      memberName,
      runtimeSessionId,
      observedAt,
    },
    bootstrapEvidencePorts
  );
  await updateOpenCodeRuntimeMemberLiveness(
    {
      teamName,
      runId,
      memberName,
      runtimeSessionId,
      observedAt,
      diagnostics: payload.diagnostics,
      metadata: parseRuntimeToolMetadata(payload.metadata),
      reason: 'OpenCode runtime bootstrap check-in accepted',
    },
    ports
  );

  return {
    ok: true,
    providerId: 'opencode',
    teamName,
    runId,
    state: 'accepted',
    memberName,
    runtimeSessionId,
    diagnostics: [],
    observedAt,
  };
}

export async function recordOpenCodeRuntimeTaskEvent<Run extends OpenCodeRuntimeCheckinRun>(
  raw: unknown,
  ports: OpenCodeRuntimeCheckinPorts<Run>
): Promise<OpenCodeRuntimeControlAck> {
  const payload = asRuntimeRecord(raw);
  const teamName = requireRuntimeString(payload.teamName, 'teamName');
  const runId = requireRuntimeString(payload.runId, 'runId');
  const memberName = requireRuntimeString(payload.memberName, 'memberName');
  const taskId = requireRuntimeString(payload.taskId, 'taskId');
  const event = requireRuntimeString(payload.event, 'event');
  const idempotencyKey = requireRuntimeString(payload.idempotencyKey, 'idempotencyKey');
  const runtimeSessionId = optionalRuntimeString(payload.runtimeSessionId);
  const observedAt = normalizeRuntimeIso(payload.createdAt);
  const laneId = await ports.resolveOpenCodeRuntimeLaneId({ teamName, runId, memberName });

  await assertOpenCodeRuntimeEvidenceAccepted(
    {
      teamName,
      runId,
      laneId,
      evidenceKind: 'delivery_call',
    },
    ports
  );

  const writeResult = await ports.upsertOpenCodeTaskRecord(teamName, {
    taskId,
    memberName,
    scope: 'member_session_window',
    ...(runtimeSessionId ? { sessionId: runtimeSessionId } : {}),
    since: observedAt,
    source: 'launch_runtime',
  });
  ports.emitTaskLogChange({
    teamName,
    runId,
    taskId,
    detail: `opencode-runtime-task-event:${event}`,
  });

  return {
    ok: true,
    providerId: 'opencode',
    teamName,
    runId,
    state: 'recorded',
    memberName,
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
    idempotencyKey,
    diagnostics: [writeResult],
    observedAt,
  };
}

export async function recordOpenCodeRuntimeHeartbeat<Run extends OpenCodeRuntimeCheckinRun>(
  raw: unknown,
  ports: OpenCodeRuntimeCheckinPorts<Run>
): Promise<OpenCodeRuntimeControlAck> {
  const payload = asRuntimeRecord(raw);
  const teamName = requireRuntimeString(payload.teamName, 'teamName');
  const runId = requireRuntimeString(payload.runId, 'runId');
  const memberName = requireRuntimeString(payload.memberName, 'memberName');
  const runtimeSessionId = requireRuntimeString(payload.runtimeSessionId, 'runtimeSessionId');
  const observedAt = normalizeRuntimeIso(payload.observedAt);
  const laneId = await ports.resolveOpenCodeRuntimeLaneId({ teamName, runId, memberName });
  const status = optionalRuntimeString(payload.status);

  await assertOpenCodeRuntimeEvidenceAccepted(
    {
      teamName,
      runId,
      laneId,
      evidenceKind: 'heartbeat',
    },
    ports
  );
  await updateOpenCodeRuntimeMemberLiveness(
    {
      teamName,
      runId,
      memberName,
      runtimeSessionId,
      observedAt,
      diagnostics: undefined,
      metadata: parseRuntimeToolMetadata(payload.metadata),
      reason: `OpenCode runtime heartbeat accepted${status ? ` (${status})` : ''}`,
    },
    ports
  );

  return {
    ok: true,
    providerId: 'opencode',
    teamName,
    runId,
    state: 'accepted',
    memberName,
    runtimeSessionId,
    diagnostics: [],
    observedAt,
  };
}

export async function assertOpenCodeRuntimeEvidenceAccepted<Run extends OpenCodeRuntimeCheckinRun>(
  input: {
    teamName: string;
    runId: string;
    laneId: string;
    evidenceKind: RuntimeEvidenceKind;
  },
  ports: Pick<
    OpenCodeRuntimeCheckinPorts<Run>,
    'teamsBasePath' | 'resolveCurrentOpenCodeRuntimeRunId'
  >
): Promise<void> {
  const store = createRuntimeRunTombstoneStore({
    filePath: getOpenCodeRuntimeRunTombstonesPath(
      ports.teamsBasePath,
      input.teamName,
      input.laneId
    ),
  });
  await store.assertEvidenceAccepted({
    teamName: input.teamName,
    runId: input.runId,
    currentRunId: await ports.resolveCurrentOpenCodeRuntimeRunId(input.teamName, input.laneId),
    evidenceKind: input.evidenceKind,
  });
}

export async function resolveOpenCodeRuntimeBootstrapCheckinIdempotency<
  Run extends OpenCodeRuntimeCheckinRun,
>(
  input: {
    teamName: string;
    runId: string;
    memberName: string;
    runtimeSessionId: string;
  },
  ports: Pick<OpenCodeRuntimeCheckinPorts<Run>, 'readLaunchState'>
): Promise<OpenCodeRuntimeBootstrapCheckinIdempotencyResult> {
  const snapshot = await ports.readLaunchState(input.teamName);
  const previousMember = snapshot?.members[input.memberName];
  return resolveOpenCodeRuntimeBootstrapCheckinIdempotencyFromMember({
    previousMember,
    runId: input.runId,
    runtimeSessionId: input.runtimeSessionId,
  });
}

export async function assertOpenCodeRuntimeMemberCheckinAllowed<
  Run extends OpenCodeRuntimeCheckinRun,
>(
  input: {
    teamName: string;
    memberName: string;
    previousMember?: PersistedTeamLaunchMemberState;
  },
  ports: Pick<OpenCodeRuntimeCheckinPorts<Run>, 'readConfigForStrictDecision' | 'readMetaMembers'>
): Promise<void> {
  const config = await ports.readConfigForStrictDecision(input.teamName).catch(() => null);
  const metaMembers = await ports.readMetaMembers(input.teamName).catch(() => []);
  const configuredMember = resolveEffectiveConfiguredMember(
    config?.members ?? [],
    metaMembers,
    input.memberName
  );

  if (configuredMember?.removedAt != null) {
    throw new RuntimeStaleEvidenceError(
      `Rejected OpenCode bootstrap check-in for removed member "${input.memberName}"`,
      'run_mismatch',
      'bootstrap_checkin',
      null
    );
  }

  if (!configuredMember && !input.previousMember) {
    throw new RuntimeStaleEvidenceError(
      `Rejected OpenCode bootstrap check-in for unconfigured member "${input.memberName}"`,
      'run_mismatch',
      'bootstrap_checkin',
      null
    );
  }
}

export async function updateOpenCodeRuntimeMemberLiveness<Run extends OpenCodeRuntimeCheckinRun>(
  input: OpenCodeRuntimeLivenessInput,
  ports: OpenCodeRuntimeCheckinPorts<Run>
): Promise<void> {
  const trackedUpdate = applyOpenCodeRuntimeBootstrapCheckinToTrackedRun(input, ports);
  if (trackedUpdate) {
    await ports.persistTrackedRunLaunchState(trackedUpdate.run);
    ports.invalidateRuntimeSnapshotCaches(input.teamName);
    if (trackedUpdate.changed) {
      ports.emitMemberSpawnChange(trackedUpdate.run, input.memberName);
    }
    return;
  }

  const previous = await ports.readLaunchState(input.teamName);
  const expectedMembers = previous
    ? getPersistedLaunchMemberNames(previous)
    : ports
        .readPersistedRuntimeMembers(input.teamName)
        .map((member) => (typeof member.name === 'string' ? member.name.trim() : ''))
        .filter((name) => name.length > 0 && name !== 'user' && !isLeadMember({ name }));
  const previousMember = previous?.members[input.memberName];
  const previousRuntimeRunId =
    typeof previousMember?.runtimeRunId === 'string' ? previousMember.runtimeRunId.trim() : '';
  const sameRuntimeRun = previousRuntimeRunId.length > 0 && previousRuntimeRunId === input.runId;
  const shouldEmitMemberSpawnChange = shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange({
    previousMember,
    runtimeRunId: input.runId,
    runtimeSessionId: input.runtimeSessionId,
    runtimePid: input.metadata?.runtimePid,
  });
  const runtimePid =
    input.metadata?.runtimePid ?? (sameRuntimeRun ? previousMember?.runtimePid : undefined);
  const pidSource = input.metadata?.runtimePid
    ? ('runtime_bootstrap' as const)
    : sameRuntimeRun
      ? previousMember?.pidSource
      : undefined;
  const persistedIdentity = resolvePersistedRuntimeMemberIdentity({
    memberName: input.memberName,
    previousMember,
    trackedRun: ports.getTrackedRun(input.teamName),
  });
  const nextMember: PersistedTeamLaunchMemberState = {
    ...persistedIdentity,
    ...(previousMember ?? {}),
    name: input.memberName,
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    bootstrapStalled: undefined,
    runtimePid,
    runtimeRunId: input.runId,
    runtimeSessionId: input.runtimeSessionId,
    livenessKind: 'confirmed_bootstrap',
    pidSource,
    runtimeDiagnostic: input.reason,
    runtimeDiagnosticSeverity: 'info',
    runtimeLastSeenAt: input.observedAt,
    firstSpawnAcceptedAt: previousMember?.firstSpawnAcceptedAt ?? input.observedAt,
    lastHeartbeatAt: input.observedAt,
    lastRuntimeAliveAt: input.observedAt,
    lastEvaluatedAt: input.observedAt,
    sources: {
      ...(previousMember?.sources ?? {}),
      nativeHeartbeat: true,
      processAlive: true,
    },
    diagnostics: mergeRuntimeDiagnostics(
      previousMember?.diagnostics,
      [
        ...normalizeRuntimeStringArray(input.diagnostics),
        ...buildRuntimeToolMetadataDiagnostics(input.metadata),
      ],
      input.reason
    ),
  };
  const snapshot = createPersistedLaunchSnapshot({
    teamName: input.teamName,
    expectedMembers: [...new Set([...expectedMembers, input.memberName])],
    leadSessionId: previous?.leadSessionId,
    launchPhase: previous?.launchPhase ?? 'active',
    members: {
      ...(previous?.members ?? {}),
      [input.memberName]: nextMember,
    },
    updatedAt: input.observedAt,
  });
  await ports.writeLaunchState(input.teamName, snapshot);
  if (shouldEmitMemberSpawnChange) {
    ports.emitRuntimeMemberSpawnChange({
      teamName: input.teamName,
      runId: input.runId,
      memberName: input.memberName,
    });
  }
}

export function applyOpenCodeRuntimeBootstrapCheckinToTrackedRun<
  Run extends OpenCodeRuntimeCheckinRun,
>(
  input: OpenCodeRuntimeLivenessInput,
  ports: Pick<
    OpenCodeRuntimeCheckinPorts<Run>,
    'getTrackedRun' | 'syncMemberTaskActivityForRuntimeTransition' | 'syncMemberLaunchGraceCheck'
  >
): { run: Run; changed: boolean } | null {
  const run = ports.getTrackedRun(input.teamName);
  if (!run || run.processKilled || run.cancelRequested) {
    return null;
  }

  const lane = (run.mixedSecondaryLanes ?? []).find((candidate) => {
    if (candidate.providerId !== 'opencode') {
      return false;
    }
    if (!matchesTeamMemberIdentity(candidate.member.name, input.memberName)) {
      return false;
    }
    return !candidate.runId || candidate.runId === input.runId;
  });
  if (!lane) {
    return null;
  }

  const runtimePid = input.metadata?.runtimePid;
  const runtimeDiagnostics = mergeRuntimeDiagnostics(
    lane.result?.members[input.memberName]?.diagnostics ?? lane.diagnostics,
    [
      ...normalizeRuntimeStringArray(input.diagnostics),
      ...buildRuntimeToolMetadataDiagnostics(input.metadata),
      'opencode_bootstrap_evidence_committed',
    ],
    input.reason
  );
  const evidence: TeamRuntimeMemberLaunchEvidence = {
    memberName: input.memberName,
    providerId: 'opencode',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    sessionId: input.runtimeSessionId,
    backendType: 'process',
    ...(runtimePid ? { runtimePid, pidSource: 'runtime_bootstrap' as const } : {}),
    livenessKind: 'confirmed_bootstrap',
    runtimeDiagnostic: input.reason,
    runtimeDiagnosticSeverity: 'info',
    diagnostics: runtimeDiagnostics ?? [input.reason],
  };

  const previousLaneState = lane.state;
  const previousLaneRunId = lane.runId;
  const previousLaneMember = lane.result?.members[input.memberName];
  lane.runId = input.runId;
  lane.state = 'finished';
  lane.diagnostics = runtimeDiagnostics ?? lane.diagnostics;
  lane.result = {
    ...(lane.result ?? {
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'finished' as const,
      teamLaunchState: 'partial_pending' as const,
      members: {},
      warnings: lane.warnings,
      diagnostics: [],
    }),
    runId: input.runId,
    teamName: input.teamName,
    launchPhase: 'finished',
    members: {
      ...(lane.result?.members ?? {}),
      [input.memberName]: evidence,
    },
    warnings: lane.result?.warnings ?? lane.warnings,
    diagnostics: runtimeDiagnostics ?? lane.result?.diagnostics ?? lane.diagnostics,
  };
  lane.result.teamLaunchState = summarizeRuntimeLaunchResultMembers(lane.result.members);

  const previousStatus =
    run.memberSpawnStatuses.get(input.memberName) ?? createInitialMemberSpawnStatusEntry();
  const nextStatus: MemberSpawnStatusEntry = {
    ...previousStatus,
    status: 'online',
    launchState: 'confirmed_alive',
    error: undefined,
    hardFailureReason: undefined,
    skippedForLaunch: undefined,
    skipReason: undefined,
    skippedAt: undefined,
    livenessSource: 'heartbeat',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    bootstrapStalled: undefined,
    pendingPermissionRequestIds: undefined,
    firstSpawnAcceptedAt: previousStatus.firstSpawnAcceptedAt ?? input.observedAt,
    lastHeartbeatAt: input.observedAt,
    runtimeModel: lane.member.model,
    livenessKind: 'confirmed_bootstrap',
    runtimeDiagnostic: input.reason,
    runtimeDiagnosticSeverity: 'info',
    livenessLastCheckedAt: input.observedAt,
    updatedAt: input.observedAt,
  };
  ports.syncMemberTaskActivityForRuntimeTransition(
    run,
    input.memberName,
    previousStatus,
    nextStatus,
    input.observedAt
  );
  run.memberSpawnStatuses.set(input.memberName, nextStatus);
  run.pendingMemberRestarts?.delete(input.memberName);
  ports.syncMemberLaunchGraceCheck(run, input.memberName, nextStatus);

  const statusChanged =
    previousStatus.status !== nextStatus.status ||
    previousStatus.launchState !== nextStatus.launchState ||
    previousStatus.bootstrapConfirmed !== nextStatus.bootstrapConfirmed ||
    previousStatus.runtimeAlive !== nextStatus.runtimeAlive ||
    previousStatus.hardFailure !== nextStatus.hardFailure ||
    previousStatus.livenessKind !== nextStatus.livenessKind;
  const laneChanged =
    previousLaneState !== lane.state ||
    previousLaneRunId !== lane.runId ||
    previousLaneMember?.sessionId !== evidence.sessionId ||
    previousLaneMember?.launchState !== evidence.launchState ||
    previousLaneMember?.bootstrapConfirmed !== evidence.bootstrapConfirmed;

  return { run, changed: statusChanged || laneChanged };
}
