import { migrateProviderBackendId } from '@shared/utils/providerBackend';

import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type {
  MemberLaunchState,
  MemberSpawnStatusEntry,
  OpenCodeAppManagedBootstrapCandidate,
  OpenCodeBootstrapEvidenceSource,
  OpenCodeBootstrapMode,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  ProviderModelLaunchIdentity,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimePidSource,
  TeamCreateRequest,
  TeamFastMode,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningMemberInput,
} from '@shared/types';

export interface MixedSecondaryLaunchReconcileLeadInboxMessage {
  from: string;
  text: string;
  timestamp: string;
  messageId?: string;
}

export interface MixedSecondaryLaneSnapshotLeadDefaults {
  providerId: TeamProviderId;
  providerBackendId?: TeamProviderBackendId | null;
  selectedFastMode?: TeamFastMode;
  resolvedFastMode?: boolean | null;
  launchIdentity?: ProviderModelLaunchIdentity | null;
}

export interface MixedSecondaryLaneSnapshotMemberInput {
  laneId: string;
  runtimeRunId?: string | null;
  member: TeamProvisioningMemberInput;
  leadDefaults: MixedSecondaryLaneSnapshotLeadDefaults;
  evidence?: {
    launchState?: MemberLaunchState;
    agentToolAccepted?: boolean;
    runtimeAlive?: boolean;
    bootstrapConfirmed?: boolean;
    hardFailure?: boolean;
    hardFailureReason?: string;
    pendingPermissionRequestIds?: string[];
    runtimePid?: number;
    runtimeSessionId?: string;
    sessionId?: string;
    bootstrapEvidenceSource?: OpenCodeBootstrapEvidenceSource;
    bootstrapMode?: OpenCodeBootstrapMode;
    appManagedBootstrapCandidate?: OpenCodeAppManagedBootstrapCandidate;
    livenessKind?: TeamAgentRuntimeLivenessKind;
    pidSource?: TeamAgentRuntimePidSource;
    runtimeDiagnostic?: string;
    runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
    bootstrapStalled?: boolean;
    firstSpawnAcceptedAt?: string;
    diagnostics?: string[];
  } | null;
  pendingReason?: string;
}

export interface MixedSecondaryLaunchSnapshotRunLike {
  teamName: string;
  detectedSessionId?: string | null;
  request: Pick<TeamCreateRequest, 'providerId' | 'providerBackendId' | 'fastMode'>;
  launchIdentity?: ProviderModelLaunchIdentity | null;
  effectiveMembers: readonly TeamProvisioningMemberInput[];
  mixedSecondaryLanes?: readonly MixedSecondaryRuntimeLaneState[];
  memberSpawnStatuses: ReadonlyMap<string, MemberSpawnStatusEntry>;
}

export interface MixedSecondaryLaunchSnapshotPorts<
  TRun extends MixedSecondaryLaunchSnapshotRunLike,
> {
  buildRuntimeSpawnStatusRecord(run: TRun): Record<string, MemberSpawnStatusEntry>;
  buildAggregateLaunchSnapshot(params: {
    teamName: string;
    leadSessionId?: string;
    launchPhase: PersistedTeamLaunchPhase;
    leadDefaults: MixedSecondaryLaneSnapshotLeadDefaults;
    primaryMembers: readonly TeamProvisioningMemberInput[];
    primaryStatuses: Record<string, MemberSpawnStatusEntry>;
    secondaryMembers?: readonly MixedSecondaryLaneSnapshotMemberInput[];
  }): PersistedTeamLaunchSnapshot;
}

export interface MixedSecondaryLaunchReconcileMessagePorts {
  resolveExpectedLaunchMemberName(
    expectedMembers: readonly string[],
    candidateName: string
  ): string | null;
  isMeaningfulBootstrapCheckInMessage(text: string): boolean;
}

export interface MixedSecondaryLaunchReconcileHeartbeatInput {
  snapshot: PersistedTeamLaunchSnapshot;
  messages: readonly MixedSecondaryLaunchReconcileLeadInboxMessage[];
  expectedMembers: readonly string[];
  ports: MixedSecondaryLaunchReconcileMessagePorts;
}

export interface SelectLatestMixedSecondaryLaunchReconcileMessageInput {
  messages: readonly MixedSecondaryLaunchReconcileLeadInboxMessage[];
  expectedMembers: readonly string[];
  expected: string;
  firstSpawnAcceptedAt?: string;
  ports: MixedSecondaryLaunchReconcileMessagePorts;
}

export interface ShouldRecoverStalePersistedMixedLaunchSnapshotInput {
  snapshot: PersistedTeamLaunchSnapshot;
  nowMs: number;
  graceMs: number;
  isRecoverablePersistedOpenCodeTerminalRuntimeCandidate(
    member: PersistedTeamLaunchMemberState | undefined | null
  ): boolean;
}

function buildMixedLeadDefaults(
  run: MixedSecondaryLaunchSnapshotRunLike
): MixedSecondaryLaneSnapshotLeadDefaults {
  const providerId = resolveTeamProviderId(run.request.providerId);
  return {
    providerId,
    providerBackendId:
      migrateProviderBackendId(run.request.providerId, run.request.providerBackendId) ?? null,
    selectedFastMode: run.request.fastMode,
    resolvedFastMode:
      typeof run.launchIdentity?.resolvedFastMode === 'boolean'
        ? run.launchIdentity.resolvedFastMode
        : null,
    launchIdentity: run.launchIdentity ?? null,
  };
}

export function buildMixedSecondaryLaunchSnapshotForRun<
  TRun extends MixedSecondaryLaunchSnapshotRunLike,
>(
  run: TRun,
  launchPhase: PersistedTeamLaunchPhase,
  ports: MixedSecondaryLaunchSnapshotPorts<TRun>
): PersistedTeamLaunchSnapshot | null {
  const mixedSecondaryLanes = run.mixedSecondaryLanes ?? [];
  if (mixedSecondaryLanes.length === 0) {
    return null;
  }

  const leadDefaults = buildMixedLeadDefaults(run);

  return ports.buildAggregateLaunchSnapshot({
    teamName: run.teamName,
    leadSessionId: run.detectedSessionId ?? undefined,
    launchPhase,
    leadDefaults,
    primaryMembers: run.effectiveMembers,
    primaryStatuses: ports.buildRuntimeSpawnStatusRecord(run),
    secondaryMembers: mixedSecondaryLanes.map((secondaryLane) => {
      const evidenceEntry = secondaryLane.result?.members[secondaryLane.member.name];
      const currentSpawnStatus = run.memberSpawnStatuses.get(secondaryLane.member.name);
      const laneFirstSpawnAcceptedAt =
        currentSpawnStatus?.firstSpawnAcceptedAt ??
        (typeof secondaryLane.launchFinishedAtMs === 'number' &&
        Number.isFinite(secondaryLane.launchFinishedAtMs)
          ? new Date(secondaryLane.launchFinishedAtMs).toISOString()
          : undefined);
      const finishedWithoutRuntimeEvidence =
        secondaryLane.state === 'finished' && !secondaryLane.result;
      const missingEvidenceDiagnostics =
        secondaryLane.diagnostics.length > 0
          ? [...secondaryLane.diagnostics]
          : [
              'OpenCode secondary lane finished without committed runtime evidence.',
              'Retry the OpenCode teammate or relaunch the team.',
            ];
      return {
        laneId: secondaryLane.laneId,
        runtimeRunId: secondaryLane.runId,
        member: secondaryLane.member,
        leadDefaults,
        evidence: evidenceEntry
          ? {
              launchState: evidenceEntry.launchState,
              agentToolAccepted: evidenceEntry.agentToolAccepted,
              runtimeAlive: evidenceEntry.runtimeAlive,
              bootstrapConfirmed: evidenceEntry.bootstrapConfirmed,
              hardFailure: evidenceEntry.hardFailure,
              hardFailureReason: evidenceEntry.hardFailureReason,
              pendingPermissionRequestIds: evidenceEntry.pendingPermissionRequestIds,
              runtimePid: evidenceEntry.runtimePid,
              sessionId: evidenceEntry.sessionId,
              livenessKind: evidenceEntry.livenessKind,
              pidSource: evidenceEntry.pidSource,
              runtimeDiagnostic: evidenceEntry.runtimeDiagnostic,
              runtimeDiagnosticSeverity: evidenceEntry.runtimeDiagnosticSeverity,
              bootstrapStalled: currentSpawnStatus?.bootstrapStalled === true ? true : undefined,
              firstSpawnAcceptedAt: laneFirstSpawnAcceptedAt,
              diagnostics: evidenceEntry.diagnostics,
            }
          : finishedWithoutRuntimeEvidence
            ? {
                launchState: 'failed_to_start' as const,
                agentToolAccepted: false,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: true,
                hardFailureReason: 'opencode_runtime_evidence_missing',
                runtimeDiagnostic:
                  'OpenCode secondary lane finished without committed runtime evidence.',
                runtimeDiagnosticSeverity: 'warning' as const,
                bootstrapStalled: currentSpawnStatus?.bootstrapStalled === true ? true : undefined,
                diagnostics: missingEvidenceDiagnostics,
              }
            : null,
        pendingReason:
          secondaryLane.result || secondaryLane.state === 'finished'
            ? undefined
            : secondaryLane.state === 'launching'
              ? 'Launching through OpenCode secondary lane.'
              : 'Queued for OpenCode secondary lane launch.',
      };
    }),
  });
}

export function hasMixedSecondaryLaunchReconcileHeartbeat(
  input: MixedSecondaryLaunchReconcileHeartbeatInput
): boolean {
  const { snapshot, messages, expectedMembers, ports } = input;
  if (expectedMembers.length === 0 || messages.length === 0) {
    return false;
  }

  return messages.some((message) => {
    if (
      typeof message.from !== 'string' ||
      typeof message.text !== 'string' ||
      typeof message.timestamp !== 'string' ||
      !ports.isMeaningfulBootstrapCheckInMessage(message.text)
    ) {
      return false;
    }

    const expected = ports.resolveExpectedLaunchMemberName(expectedMembers, message.from);
    if (!expected) {
      return false;
    }

    const current = snapshot.members[expected];
    const firstAcceptedAt = current?.firstSpawnAcceptedAt
      ? Date.parse(current.firstSpawnAcceptedAt)
      : NaN;
    const messageTs = Date.parse(message.timestamp);
    return (
      !Number.isFinite(firstAcceptedAt) ||
      !Number.isFinite(messageTs) ||
      messageTs >= firstAcceptedAt
    );
  });
}

export function selectLatestMixedSecondaryLaunchReconcileMessage(
  input: SelectLatestMixedSecondaryLaunchReconcileMessageInput
): MixedSecondaryLaunchReconcileLeadInboxMessage | null {
  const { messages, expectedMembers, expected, firstSpawnAcceptedAt, ports } = input;
  const firstAcceptedAt = firstSpawnAcceptedAt ? Date.parse(firstSpawnAcceptedAt) : NaN;
  const candidates = messages.filter((message) => {
    if (
      typeof message.from !== 'string' ||
      ports.resolveExpectedLaunchMemberName(expectedMembers, message.from) !== expected
    ) {
      return false;
    }
    if (
      typeof message.text !== 'string' ||
      !ports.isMeaningfulBootstrapCheckInMessage(message.text)
    ) {
      return false;
    }
    const messageTs = Date.parse(message.timestamp);
    if (
      Number.isFinite(firstAcceptedAt) &&
      Number.isFinite(messageTs) &&
      messageTs < firstAcceptedAt
    ) {
      return false;
    }
    return true;
  });

  return (
    candidates.sort((left, right) => {
      const leftMs = Date.parse(left.timestamp);
      const rightMs = Date.parse(right.timestamp);
      const leftValid = Number.isFinite(leftMs);
      const rightValid = Number.isFinite(rightMs);
      if (leftValid && rightValid && leftMs !== rightMs) {
        return rightMs - leftMs;
      }
      if (leftValid !== rightValid) {
        return leftValid ? -1 : 1;
      }
      return (right.messageId ?? '').localeCompare(left.messageId ?? '');
    })[0] ?? null
  );
}

export function shouldRecoverStalePersistedMixedLaunchSnapshot(
  input: ShouldRecoverStalePersistedMixedLaunchSnapshotInput
): boolean {
  const { snapshot, nowMs, graceMs, isRecoverablePersistedOpenCodeTerminalRuntimeCandidate } =
    input;
  const hasRecoverableOpenCodeRuntimeCandidate = Object.values(snapshot.members).some((member) =>
    isRecoverablePersistedOpenCodeTerminalRuntimeCandidate(member)
  );
  if (hasRecoverableOpenCodeRuntimeCandidate) {
    return true;
  }

  if (snapshot.teamLaunchState !== 'partial_pending') {
    return false;
  }
  const updatedAtMs = Date.parse(snapshot.updatedAt);
  if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs < graceMs) {
    return false;
  }

  return Object.values(snapshot.members).some((member) => {
    if (member.launchState === 'confirmed_alive' || member.launchState === 'failed_to_start') {
      return false;
    }
    return (
      member.laneKind === 'secondary' &&
      member.laneOwnerProviderId === 'opencode' &&
      typeof member.laneId === 'string'
    );
  });
}
