import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import {
  isRecoverableOpenCodeRuntimeEvidence,
  isRecoverablePersistedOpenCodeRuntimeCandidate,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type {
  OpenCodeRuntimeLaneIndex,
  OpenCodeRuntimeLaneIndexEntry,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import type { TeamRuntimeMemberLaunchEvidence } from '../runtime/TeamRuntimeAdapter';
import type {
  MemberLaunchState,
  MemberSpawnStatusEntry,
  OpenCodeAppManagedBootstrapCandidate,
  OpenCodeBootstrapEvidenceSource,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  ProviderModelLaunchIdentity,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimePidSource,
  TeamFastMode,
  TeamMember,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export interface StaleMixedSecondaryTeamMeta {
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId | string;
  fastMode?: TeamFastMode;
  launchIdentity?: ProviderModelLaunchIdentity;
}

export interface StaleMixedSecondaryMembersMeta {
  providerBackendId?: TeamProviderBackendId | string;
  members: TeamMember[];
}

export interface StaleMixedSecondaryLaneIdentity {
  laneId: string;
  laneKind: 'primary' | 'secondary';
  laneOwnerProviderId: TeamProviderId;
}

export interface StaleMixedSecondaryLeadDefaults {
  providerId: TeamProviderId;
  providerBackendId?: TeamProviderBackendId | null;
  selectedFastMode?: TeamFastMode;
  resolvedFastMode?: boolean | null;
  launchIdentity?: ProviderModelLaunchIdentity | null;
}

export interface StaleMixedSecondaryMemberInput {
  laneId: string;
  runtimeRunId?: string | null;
  member: TeamMember;
  leadDefaults: StaleMixedSecondaryLeadDefaults;
  evidence?: {
    launchState?: MemberLaunchState;
    agentToolAccepted?: boolean;
    runtimeAlive?: boolean;
    bootstrapConfirmed?: boolean;
    hardFailure?: boolean;
    hardFailureReason?: string;
    pendingPermissionRequestIds?: string[];
    runtimePid?: number;
    sessionId?: string;
    runtimeSessionId?: string;
    bootstrapEvidenceSource?: OpenCodeBootstrapEvidenceSource;
    bootstrapMode?: 'model_tool_checkin' | 'app_managed_context';
    appManagedBootstrapCandidate?: OpenCodeAppManagedBootstrapCandidate;
    livenessKind?: TeamAgentRuntimeLivenessKind;
    pidSource?: TeamAgentRuntimePidSource;
    runtimeDiagnostic?: string;
    runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
    firstSpawnAcceptedAt?: string;
    diagnostics?: string[];
  };
  pendingReason?: string;
}

export interface StaleMixedSecondaryRecoveryPorts {
  hasMixedSecondaryLaunchMetadata(snapshot: PersistedTeamLaunchSnapshot | null): boolean;
  shouldRecoverStalePersistedMixedLaunchSnapshot(snapshot: PersistedTeamLaunchSnapshot): boolean;
  readTeamMeta(teamName: string): Promise<StaleMixedSecondaryTeamMeta | null>;
  readMembersMeta(teamName: string): Promise<StaleMixedSecondaryMembersMeta | null>;
  readPersistedTeamProjectPath(teamName: string): string | null;
  readOpenCodeRuntimeLaneIndex(
    teamsBasePath: string,
    teamName: string
  ): Promise<OpenCodeRuntimeLaneIndex>;
  buildPlannedMemberLaneIdentity(input: {
    leadProviderId: TeamProviderId;
    member: {
      name: string;
      providerId?: TeamProviderId;
    };
  }): StaleMixedSecondaryLaneIdentity;
  buildOpenCodeSecondaryLaneId(member: TeamMember): string;
  snapshotToMemberSpawnStatuses(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Record<string, MemberSpawnStatusEntry>;
  createInitialMemberSpawnStatusEntry(): MemberSpawnStatusEntry;
  isLeadMember(member: Pick<TeamMember, 'name'>): boolean;
  tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    persistedMember: PersistedTeamLaunchMemberState;
  }): Promise<TeamRuntimeMemberLaunchEvidence | null>;
  tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<TeamRuntimeMemberLaunchEvidence | null>;
  resolveCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): Promise<string | null>;
  recoverStaleOpenCodeRuntimeLaneIndexEntry(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
  }): Promise<{
    stale: boolean;
    degraded: boolean;
    diagnostics: string[];
  }>;
  nowIso(): string;
  getTeamsBasePath(): string;
  buildAggregateLaunchSnapshot(input: {
    teamName: string;
    leadSessionId?: string;
    launchPhase: PersistedTeamLaunchPhase;
    leadDefaults: StaleMixedSecondaryLeadDefaults;
    primaryMembers: readonly TeamMember[];
    primaryStatuses: Record<string, MemberSpawnStatusEntry>;
    secondaryMembers: readonly StaleMixedSecondaryMemberInput[];
  }): PersistedTeamLaunchSnapshot;
  writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<PersistedTeamLaunchSnapshot | null>;
}

function createEmptyLaneIndex(nowIso: string): OpenCodeRuntimeLaneIndex {
  return {
    version: 1,
    updatedAt: nowIso,
    lanes: {},
  };
}

export async function recoverStaleMixedSecondaryLaunchSnapshotWithPorts(
  teamName: string,
  bootstrapSnapshot: PersistedTeamLaunchSnapshot | null,
  persistedSnapshot: PersistedTeamLaunchSnapshot | null,
  ports: StaleMixedSecondaryRecoveryPorts
): Promise<PersistedTeamLaunchSnapshot | null> {
  if (
    persistedSnapshot &&
    ports.hasMixedSecondaryLaunchMetadata(persistedSnapshot) &&
    !ports.shouldRecoverStalePersistedMixedLaunchSnapshot(persistedSnapshot)
  ) {
    return persistedSnapshot;
  }

  const teamMeta = await ports.readTeamMeta(teamName).catch(() => null);
  const leadLaunchIdentity = teamMeta?.launchIdentity;
  const leadProviderId =
    normalizeOptionalTeamProviderId(leadLaunchIdentity?.providerId) ??
    normalizeOptionalTeamProviderId(teamMeta?.providerId);
  if (!leadProviderId) {
    return null;
  }

  const membersMeta = await ports.readMembersMeta(teamName).catch(() => null);
  const activeMembers = (membersMeta?.members ?? []).filter(
    (member) => !member.removedAt && !ports.isLeadMember({ name: member.name })
  );
  if (activeMembers.length === 0) {
    return null;
  }
  const projectPath = ports.readPersistedTeamProjectPath(teamName);

  const laneIndex = await ports
    .readOpenCodeRuntimeLaneIndex(ports.getTeamsBasePath(), teamName)
    .catch(() => createEmptyLaneIndex(ports.nowIso()));
  const bootstrapStatuses = ports.snapshotToMemberSpawnStatuses(bootstrapSnapshot);
  const leadDefaults = {
    providerId: leadProviderId,
    providerBackendId:
      migrateProviderBackendId(
        leadProviderId,
        leadLaunchIdentity
          ? (leadLaunchIdentity.providerBackendId ??
              teamMeta?.providerBackendId ??
              membersMeta?.providerBackendId)
          : (teamMeta?.providerBackendId ?? membersMeta?.providerBackendId)
      ) ?? null,
    selectedFastMode: leadLaunchIdentity?.selectedFastMode ?? teamMeta?.fastMode,
    resolvedFastMode:
      typeof teamMeta?.launchIdentity?.resolvedFastMode === 'boolean'
        ? teamMeta.launchIdentity.resolvedFastMode
        : null,
    launchIdentity: teamMeta?.launchIdentity ?? null,
  };
  const primaryMembers: TeamMember[] = [];
  const secondaryMembers: StaleMixedSecondaryMemberInput[] = [];
  let recoveredAny = false;

  for (const member of activeMembers) {
    const persistedMember =
      persistedSnapshot?.members?.[member.name] ?? bootstrapSnapshot?.members?.[member.name];
    const laneIdentity =
      leadProviderId === 'opencode'
        ? (() => {
            const persistedLaneId = persistedMember?.laneId?.startsWith('secondary:opencode:')
              ? persistedMember.laneId
              : null;
            const generatedLaneId = ports.buildOpenCodeSecondaryLaneId(member);
            const memberCwd = member.cwd?.trim();
            const projectRoot = projectPath?.trim();
            const hasWorktreeRoot =
              Boolean(memberCwd) && (!projectRoot || memberCwd !== projectRoot);
            if (!persistedLaneId && !laneIndex.lanes[generatedLaneId] && !hasWorktreeRoot) {
              return {
                laneId: 'primary',
                laneKind: 'primary',
                laneOwnerProviderId: leadProviderId,
              } as const;
            }
            return {
              laneId: persistedLaneId ?? generatedLaneId,
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
            } as const;
          })()
        : ports.buildPlannedMemberLaneIdentity({
            leadProviderId,
            member: {
              name: member.name,
              providerId: normalizeOptionalTeamProviderId(member.providerId),
            },
          });

    if (
      laneIdentity.laneKind !== 'secondary' ||
      laneIdentity.laneOwnerProviderId !== 'opencode'
    ) {
      primaryMembers.push(member);
      continue;
    }

    let laneEntry: OpenCodeRuntimeLaneIndexEntry | undefined = laneIndex.lanes[laneIdentity.laneId];
    if (
      !laneEntry &&
      persistedMember &&
      isRecoverablePersistedOpenCodeRuntimeCandidate(persistedMember) &&
      persistedMember.laneId === laneIdentity.laneId
    ) {
      const runtimeEvidence = await ports.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime({
        teamName,
        laneId: laneIdentity.laneId,
        member,
        projectPath,
        previousLaunchState: persistedSnapshot ?? bootstrapSnapshot,
        persistedMember,
      });
      if (runtimeEvidence) {
        recoveredAny = true;
        secondaryMembers.push({
          laneId: laneIdentity.laneId,
          runtimeRunId: persistedMember.runtimeRunId,
          member,
          leadDefaults,
          evidence: {
            launchState: runtimeEvidence.launchState,
            agentToolAccepted: runtimeEvidence.agentToolAccepted,
            runtimeAlive: runtimeEvidence.runtimeAlive,
            bootstrapConfirmed: runtimeEvidence.bootstrapConfirmed,
            hardFailure: runtimeEvidence.hardFailure,
            hardFailureReason: runtimeEvidence.hardFailureReason,
            pendingPermissionRequestIds: runtimeEvidence.pendingPermissionRequestIds,
            runtimePid: runtimeEvidence.runtimePid,
            sessionId: runtimeEvidence.sessionId,
            runtimeSessionId: runtimeEvidence.sessionId,
            bootstrapEvidenceSource: runtimeEvidence.bootstrapEvidenceSource,
            bootstrapMode: runtimeEvidence.bootstrapMode,
            appManagedBootstrapCandidate: runtimeEvidence.appManagedBootstrapCandidate,
            livenessKind: runtimeEvidence.livenessKind,
            pidSource: runtimeEvidence.pidSource,
            runtimeDiagnostic: runtimeEvidence.runtimeDiagnostic,
            runtimeDiagnosticSeverity: runtimeEvidence.runtimeDiagnosticSeverity,
            firstSpawnAcceptedAt: persistedMember.firstSpawnAcceptedAt,
            diagnostics: runtimeEvidence.diagnostics,
          },
        });
        continue;
      }
    }
    if (laneEntry?.state === 'active') {
      const runtimeEvidence = await ports.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime({
        teamName,
        laneId: laneIdentity.laneId,
        member,
        projectPath,
        previousLaunchState: persistedSnapshot ?? bootstrapSnapshot,
      });
      if (isRecoverableOpenCodeRuntimeEvidence(runtimeEvidence)) {
        recoveredAny = true;
        const runtimeRunId =
          runtimeEvidence.appManagedBootstrapCandidate?.runId ??
          (await ports.resolveCurrentOpenCodeRuntimeRunId(teamName, laneIdentity.laneId)) ??
          persistedMember?.runtimeRunId?.trim() ??
          undefined;
        secondaryMembers.push({
          laneId: laneIdentity.laneId,
          runtimeRunId,
          member,
          leadDefaults,
          evidence: {
            launchState: runtimeEvidence.launchState,
            agentToolAccepted: runtimeEvidence.agentToolAccepted,
            runtimeAlive: runtimeEvidence.runtimeAlive,
            bootstrapConfirmed: runtimeEvidence.bootstrapConfirmed,
            hardFailure: runtimeEvidence.hardFailure,
            hardFailureReason: runtimeEvidence.hardFailureReason,
            pendingPermissionRequestIds: runtimeEvidence.pendingPermissionRequestIds,
            runtimePid: runtimeEvidence.runtimePid,
            sessionId: runtimeEvidence.sessionId,
            bootstrapEvidenceSource: runtimeEvidence.bootstrapEvidenceSource,
            bootstrapMode: runtimeEvidence.bootstrapMode,
            appManagedBootstrapCandidate: runtimeEvidence.appManagedBootstrapCandidate,
            livenessKind: runtimeEvidence.livenessKind,
            pidSource: runtimeEvidence.pidSource,
            runtimeDiagnostic: runtimeEvidence.runtimeDiagnostic,
            runtimeDiagnosticSeverity: runtimeEvidence.runtimeDiagnosticSeverity,
            firstSpawnAcceptedAt: persistedMember?.firstSpawnAcceptedAt,
            diagnostics: runtimeEvidence.diagnostics,
          },
        });
        continue;
      }
      const recovery = await ports.recoverStaleOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: ports.getTeamsBasePath(),
        teamName,
        laneId: laneIdentity.laneId,
      });
      if (recovery.stale) {
        recoveredAny = true;
        laneEntry = {
          laneId: laneIdentity.laneId,
          state: 'degraded',
          updatedAt: ports.nowIso(),
          diagnostics: recovery.diagnostics,
        };
      }
    }

    if (laneEntry?.state === 'degraded') {
      recoveredAny = true;
      const diagnostics = laneEntry.diagnostics?.length
        ? [...laneEntry.diagnostics]
        : [`OpenCode lane ${laneIdentity.laneId} is degraded and requires stop + relaunch.`];
      secondaryMembers.push({
        laneId: laneIdentity.laneId,
        member,
        leadDefaults,
        evidence: {
          launchState: 'failed_to_start',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: diagnostics[0],
          diagnostics,
        },
      });
      continue;
    }

    secondaryMembers.push({
      laneId: laneIdentity.laneId,
      member,
      leadDefaults,
      pendingReason: 'Waiting for OpenCode secondary lane recovery.',
    });
  }

  if (!recoveredAny) {
    return null;
  }

  const primaryStatuses = Object.fromEntries(
    primaryMembers.map((member) => [
      member.name,
      bootstrapStatuses[member.name] ?? ports.createInitialMemberSpawnStatusEntry(),
    ])
  );
  const recoveredSnapshot = ports.buildAggregateLaunchSnapshot({
    teamName,
    leadSessionId: persistedSnapshot?.leadSessionId ?? bootstrapSnapshot?.leadSessionId,
    launchPhase:
      persistedSnapshot?.launchPhase === 'active'
        ? 'active'
        : bootstrapSnapshot?.launchPhase === 'active'
          ? 'active'
          : 'reconciled',
    leadDefaults,
    primaryMembers,
    primaryStatuses,
    secondaryMembers,
  });
  return ports.writeLaunchStateSnapshot(teamName, recoveredSnapshot);
}
