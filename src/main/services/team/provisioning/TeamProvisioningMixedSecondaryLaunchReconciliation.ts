import { migrateProviderBackendId } from '@shared/utils/providerBackend';

import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type {
  MemberLaunchState,
  MemberSpawnStatusEntry,
  OpenCodeAppManagedBootstrapCandidate,
  OpenCodeBootstrapEvidenceSource,
  OpenCodeBootstrapMode,
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
                launchState: 'runtime_pending_bootstrap',
                agentToolAccepted: false,
                runtimeAlive: false,
                bootstrapConfirmed: false,
                hardFailure: false,
                bootstrapStalled: currentSpawnStatus?.bootstrapStalled === true ? true : undefined,
                diagnostics:
                  secondaryLane.diagnostics.length > 0
                    ? [...secondaryLane.diagnostics]
                    : [
                        'OpenCode secondary lane finished without runtime evidence. Waiting for runtime reconciliation.',
                      ],
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
