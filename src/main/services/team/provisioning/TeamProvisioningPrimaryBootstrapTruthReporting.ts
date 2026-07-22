import { hasUnsafeProvisionedButNotAliveRuntimeEvidence } from '@shared/utils/teamLaunchFailureReason';

import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

import {
  isBootstrapProofClearableLaunchFailureReason,
  shouldClearRuntimeDiagnosticAfterBootstrapConfirmation,
} from './TeamProvisioningBootstrapTranscript';
import { isProvisionedButNotAliveFailureReason } from './TeamProvisioningLaunchFailurePolicy';
import {
  type LaunchStateProjectionSecondaryLaneLike,
  shouldOverlayPrimaryBootstrapTruth,
} from './TeamProvisioningLaunchStateProjection';
import { isMemberSpawnHeartbeatTimestampNewer } from './TeamProvisioningMemberSpawnCursor';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';
import { isPersistedOpenCodeSecondaryLaneMember } from './TeamProvisioningOpenCodeDiagnosticsPolicy';
import { isBootstrapMemberEvidenceCurrentForMember } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

export interface PrimaryBootstrapTruthMemberLike {
  name?: string | null;
}

export interface PrimaryBootstrapTruthRunLike {
  teamName: string;
  runId: string;
  startedAt: string;
  isLaunch?: boolean;
  deterministicBootstrap?: boolean;
  effectiveMembers?: readonly PrimaryBootstrapTruthMemberLike[];
  expectedMembers?: readonly string[];
  mixedSecondaryLanes?: readonly LaunchStateProjectionSecondaryLaneLike[];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  pendingMemberRestarts?: { delete(memberName: string): unknown };
}

export interface PrimaryBootstrapTruthReportingPorts<TRun extends PrimaryBootstrapTruthRunLike> {
  readBootstrapLaunchSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  nowIso(): string;
  isOpenCodeSecondaryLaneMemberInRun(run: TRun, memberName: string): boolean;
  syncMemberTaskActivityForRuntimeTransition(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry,
    observedAt: string
  ): void;
  syncMemberLaunchGraceCheck(run: TRun, memberName: string, next: MemberSpawnStatusEntry): void;
}

export async function overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState<
  TRun extends PrimaryBootstrapTruthRunLike,
>(run: TRun, ports: PrimaryBootstrapTruthReportingPorts<TRun>): Promise<void> {
  if (!shouldOverlayPrimaryBootstrapTruth(run)) {
    return;
  }

  let bootstrapSnapshot: PersistedTeamLaunchSnapshot | null = null;
  try {
    bootstrapSnapshot = await ports.readBootstrapLaunchSnapshot(run.teamName);
  } catch {
    return;
  }
  if (!bootstrapSnapshot) {
    return;
  }

  const runStartedAtMs = Date.parse(run.startedAt);
  const bootstrapUpdatedAtMs = Date.parse(bootstrapSnapshot.updatedAt);
  if (
    !Number.isFinite(runStartedAtMs) ||
    !Number.isFinite(bootstrapUpdatedAtMs) ||
    bootstrapUpdatedAtMs < runStartedAtMs
  ) {
    return;
  }

  const primaryMemberNames = new Set(
    [...(run.effectiveMembers ?? []), ...(run.expectedMembers ?? []).map((name) => ({ name }))]
      .map((member) => member.name?.trim())
      .filter((name): name is string => Boolean(name))
  );
  if (primaryMemberNames.size === 0) {
    return;
  }

  const updatedAt = ports.nowIso();
  for (const memberName of primaryMemberNames) {
    if (ports.isOpenCodeSecondaryLaneMemberInRun(run, memberName)) {
      continue;
    }
    const bootstrapMember = bootstrapSnapshot.members[memberName];
    if (bootstrapMember?.bootstrapConfirmed !== true) {
      continue;
    }
    const current =
      run.memberSpawnStatuses.get(memberName) ?? createInitialMemberSpawnStatusEntry();
    if (
      !isBootstrapMemberEvidenceCurrentForMember(
        { ...current, runtimeRunId: run.runId },
        bootstrapMember,
        'confirmation'
      )
    ) {
      continue;
    }
    if (current.launchState === 'skipped_for_launch' || current.skippedForLaunch === true) {
      continue;
    }
    const failureReason = current.hardFailureReason ?? current.error ?? current.runtimeDiagnostic;
    const provisionedButNotAliveFailure = isProvisionedButNotAliveFailureReason(failureReason);
    if (provisionedButNotAliveFailure && hasUnsafeProvisionedButNotAliveRuntimeEvidence(current)) {
      continue;
    }
    if (
      current.launchState === 'failed_to_start' &&
      !isBootstrapProofClearableLaunchFailureReason(failureReason)
    ) {
      continue;
    }

    const observedAt =
      bootstrapMember.lastHeartbeatAt ??
      bootstrapMember.lastEvaluatedAt ??
      bootstrapSnapshot.updatedAt ??
      updatedAt;
    const next: MemberSpawnStatusEntry = {
      ...current,
      status: 'online',
      updatedAt,
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      bootstrapStalled: undefined,
      error: undefined,
      hardFailureReason: undefined,
      livenessSource: current.livenessSource ?? 'heartbeat',
      firstSpawnAcceptedAt:
        current.firstSpawnAcceptedAt ?? bootstrapMember.firstSpawnAcceptedAt ?? observedAt,
      lastHeartbeatAt: isMemberSpawnHeartbeatTimestampNewer(current.lastHeartbeatAt, observedAt)
        ? observedAt
        : current.lastHeartbeatAt,
      livenessLastCheckedAt: updatedAt,
      launchState: 'confirmed_alive',
    };
    ports.syncMemberTaskActivityForRuntimeTransition(run, memberName, current, next, updatedAt);
    run.memberSpawnStatuses.set(memberName, next);
    run.pendingMemberRestarts?.delete(memberName);
    ports.syncMemberLaunchGraceCheck(run, memberName, next);
  }
}

export async function applyPrimaryBootstrapTruthToLaunchReportingSnapshot<
  TRun extends PrimaryBootstrapTruthRunLike,
>(
  run: TRun,
  snapshot: PersistedTeamLaunchSnapshot | null,
  ports: Pick<
    PrimaryBootstrapTruthReportingPorts<TRun>,
    'readBootstrapLaunchSnapshot' | 'nowIso' | 'isOpenCodeSecondaryLaneMemberInRun'
  >
): Promise<PersistedTeamLaunchSnapshot | null> {
  if (!shouldOverlayPrimaryBootstrapTruth(run) || !snapshot) {
    return snapshot;
  }

  let bootstrapSnapshot: PersistedTeamLaunchSnapshot | null = null;
  try {
    bootstrapSnapshot = await ports.readBootstrapLaunchSnapshot(run.teamName);
  } catch {
    return snapshot;
  }
  if (!bootstrapSnapshot) {
    return snapshot;
  }

  const runStartedAtMs = Date.parse(run.startedAt);
  const bootstrapUpdatedAtMs = Date.parse(bootstrapSnapshot.updatedAt);
  if (
    !Number.isFinite(runStartedAtMs) ||
    !Number.isFinite(bootstrapUpdatedAtMs) ||
    bootstrapUpdatedAtMs < runStartedAtMs
  ) {
    return snapshot;
  }

  const primaryMemberNames = new Set(
    [
      ...(run.effectiveMembers ?? []).map((member) => member.name?.trim() ?? ''),
      ...(snapshot.bootstrapExpectedMembers ?? []),
    ].filter((name): name is string => name.length > 0)
  );
  if (primaryMemberNames.size === 0) {
    return snapshot;
  }

  let changed = false;
  const updatedAt = ports.nowIso();
  const nextMembers: Record<string, PersistedTeamLaunchMemberState> = { ...snapshot.members };
  for (const memberName of primaryMemberNames) {
    const current = nextMembers[memberName];
    const bootstrapMember = bootstrapSnapshot.members[memberName];
    if (!current || bootstrapMember?.bootstrapConfirmed !== true) {
      continue;
    }
    if (
      !isBootstrapMemberEvidenceCurrentForMember(
        { ...current, runtimeRunId: run.runId },
        bootstrapMember,
        'confirmation'
      )
    ) {
      continue;
    }
    if (
      current.providerId === 'opencode' ||
      isPersistedOpenCodeSecondaryLaneMember(current) ||
      ports.isOpenCodeSecondaryLaneMemberInRun(run, memberName)
    ) {
      continue;
    }
    if (current.launchState === 'skipped_for_launch' || current.skippedForLaunch === true) {
      continue;
    }

    const persistedError =
      typeof (current as { error?: unknown }).error === 'string'
        ? (current as { error?: string }).error
        : undefined;
    const failureReason = current.hardFailureReason ?? persistedError ?? current.runtimeDiagnostic;
    const provisionedButNotAliveFailure = isProvisionedButNotAliveFailureReason(failureReason);
    if (provisionedButNotAliveFailure && hasUnsafeProvisionedButNotAliveRuntimeEvidence(current)) {
      continue;
    }
    const hasFailure =
      current.launchState === 'failed_to_start' ||
      current.hardFailure === true ||
      typeof current.hardFailureReason === 'string' ||
      typeof persistedError === 'string';
    if (hasFailure && !isBootstrapProofClearableLaunchFailureReason(failureReason)) {
      continue;
    }

    const observedAt =
      bootstrapMember.lastHeartbeatAt ??
      bootstrapMember.lastEvaluatedAt ??
      bootstrapSnapshot.updatedAt ??
      updatedAt;
    nextMembers[memberName] = {
      ...current,
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      hardFailureReason: undefined,
      runtimeDiagnostic: shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(
        current.runtimeDiagnostic
      )
        ? undefined
        : current.runtimeDiagnostic,
      runtimeDiagnosticSeverity: shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(
        current.runtimeDiagnostic
      )
        ? undefined
        : current.runtimeDiagnosticSeverity,
      bootstrapStalled: undefined,
      firstSpawnAcceptedAt:
        current.firstSpawnAcceptedAt ?? bootstrapMember.firstSpawnAcceptedAt ?? observedAt,
      lastHeartbeatAt: current.lastHeartbeatAt ?? bootstrapMember.lastHeartbeatAt ?? observedAt,
      lastRuntimeAliveAt:
        current.lastRuntimeAliveAt ?? bootstrapMember.lastRuntimeAliveAt ?? observedAt,
      lastEvaluatedAt: updatedAt,
      sources: {
        ...(current.sources ?? {}),
        nativeHeartbeat: true,
        hardFailureSignal: undefined,
      },
      diagnostics: undefined,
    };
    changed = true;
  }

  if (!changed) {
    return snapshot;
  }

  return createPersistedLaunchSnapshot({
    teamName: snapshot.teamName,
    expectedMembers: snapshot.expectedMembers,
    bootstrapExpectedMembers: snapshot.bootstrapExpectedMembers,
    leadSessionId: snapshot.leadSessionId,
    launchPhase: snapshot.launchPhase,
    members: nextMembers,
    updatedAt,
  });
}
