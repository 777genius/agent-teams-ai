import { matchesObservedMemberNameForExpected } from './TeamProvisioningMemberIdentity';
import { buildRestartGraceTimeoutReason } from './TeamProvisioningMemberSpawnStatusPolicy';
import {
  markOpenCodeSecondaryBootstrapStalled,
  type MarkOpenCodeSecondaryBootstrapStalledPorts,
  type OpenCodeBootstrapStallRunLike,
  type ReconcileOpenCodeRuntimeProcessBootstrapPorts,
  reconcileOpenCodeRuntimeProcessBootstrapStatus,
} from './TeamProvisioningOpenCodeBootstrapStall';
import { MEMBER_BOOTSTRAP_STALL_MS } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type {
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
} from '@shared/types';

export interface ReevaluateMemberLaunchStatusRunLike extends OpenCodeBootstrapStallRunLike {
  pendingMemberRestarts: Pick<Map<string, unknown>, 'delete' | 'has'>;
}

export interface ReevaluateMemberLaunchStatusPorts<
  TRun extends ReevaluateMemberLaunchStatusRunLike,
> {
  nowIso(): string;
  nowMs(): number;
  isCurrentTrackedRun(run: TRun): boolean;
  refreshMemberSpawnStatusesFromLeadInbox(run: TRun): Promise<void>;
  maybeAuditMemberSpawnStatuses(run: TRun, options: { force: true }): Promise<void>;
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>>;
  isOpenCodeSecondaryLaneMemberInRun(run: TRun, memberName: string): boolean;
  reconcileOpenCodeBootstrapStallPorts: ReconcileOpenCodeRuntimeProcessBootstrapPorts &
    MarkOpenCodeSecondaryBootstrapStalledPorts;
  setMemberSpawnStatus(
    run: TRun,
    memberName: string,
    status: MemberSpawnStatus,
    error?: string,
    livenessSource?: MemberSpawnLivenessSource
  ): void;
  emitMemberSpawnChange(run: TRun, memberName: string): void;
  scheduleOpenCodeBootstrapStallReevaluation(
    run: TRun,
    memberName: string,
    firstSpawnAcceptedAt: string
  ): void;
  syncMemberTaskActivityForRuntimeTransition(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry,
    observedAt: string
  ): void;
}

function isCurrentMemberLaunch<TRun extends ReevaluateMemberLaunchStatusRunLike>(
  run: TRun,
  memberName: string,
  firstSpawnAcceptedAt: string,
  ports: Pick<ReevaluateMemberLaunchStatusPorts<TRun>, 'isCurrentTrackedRun'>
): boolean {
  return (
    ports.isCurrentTrackedRun(run) &&
    run.memberSpawnStatuses.get(memberName)?.firstSpawnAcceptedAt === firstSpawnAcceptedAt
  );
}

function isCurrentMemberStatus<TRun extends ReevaluateMemberLaunchStatusRunLike>(
  run: TRun,
  memberName: string,
  expected: MemberSpawnStatusEntry,
  ports: Pick<ReevaluateMemberLaunchStatusPorts<TRun>, 'isCurrentTrackedRun'>
): boolean {
  return ports.isCurrentTrackedRun(run) && run.memberSpawnStatuses.get(memberName) === expected;
}

function guardOpenCodeReconciliationPorts<TRun extends ReevaluateMemberLaunchStatusRunLike>(
  run: TRun,
  memberName: string,
  expected: MemberSpawnStatusEntry,
  firstSpawnAcceptedAt: string,
  ports: ReevaluateMemberLaunchStatusPorts<TRun>
): ReconcileOpenCodeRuntimeProcessBootstrapPorts & MarkOpenCodeSecondaryBootstrapStalledPorts {
  const source = ports.reconcileOpenCodeBootstrapStallPorts;
  let continuationCurrent = true;
  const isCurrent = () =>
    continuationCurrent && isCurrentMemberLaunch(run, memberName, firstSpawnAcceptedAt, ports);

  return {
    ...source,
    buildOpenCodeSecondaryBootstrapStallDiagnostic: async (...args) => {
      const diagnostic = await source.buildOpenCodeSecondaryBootstrapStallDiagnostic(...args);
      continuationCurrent = isCurrentMemberStatus(run, memberName, expected, ports);
      return diagnostic;
    },
    setOpenCodeRuntimePendingBootstrapStatus: (...args) => {
      if (!isCurrent()) return;
      source.setOpenCodeRuntimePendingBootstrapStatus(...args);
    },
    setOpenCodeSecondaryBootstrapStalledStatus: (...args) => {
      if (!isCurrent()) return;
      source.setOpenCodeSecondaryBootstrapStalledStatus(...args);
    },
    maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt: async (...args) => {
      if (!isCurrent()) return;
      await source.maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt(...args);
      continuationCurrent = isCurrentMemberLaunch(run, memberName, firstSpawnAcceptedAt, ports);
    },
    scheduleOpenCodeBootstrapStallReevaluation: (...args) => {
      if (!isCurrent()) return;
      source.scheduleOpenCodeBootstrapStallReevaluation(...args);
    },
  };
}

function resolveRuntimeMetadataForMember(
  runtimeByMember: ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>,
  memberName: string
): LiveTeamAgentRuntimeMetadata | undefined {
  return (
    runtimeByMember.get(memberName) ??
    [...runtimeByMember.entries()].find(([candidateName]) =>
      matchesObservedMemberNameForExpected(candidateName, memberName)
    )?.[1]
  );
}

export async function reevaluateMemberLaunchStatus<
  TRun extends ReevaluateMemberLaunchStatusRunLike,
>(run: TRun, memberName: string, ports: ReevaluateMemberLaunchStatusPorts<TRun>): Promise<void> {
  if (!ports.isCurrentTrackedRun(run)) return;
  const current = run.memberSpawnStatuses.get(memberName);
  if (!current) return;
  if (
    current.launchState === 'failed_to_start' ||
    current.launchState === 'confirmed_alive' ||
    !current.firstSpawnAcceptedAt
  ) {
    return;
  }
  const firstSpawnAcceptedAt = current.firstSpawnAcceptedAt;
  await ports.refreshMemberSpawnStatusesFromLeadInbox(run);
  if (!isCurrentMemberLaunch(run, memberName, firstSpawnAcceptedAt, ports)) return;
  await ports.maybeAuditMemberSpawnStatuses(run, { force: true });
  if (!isCurrentMemberLaunch(run, memberName, firstSpawnAcceptedAt, ports)) return;
  const refreshed = run.memberSpawnStatuses.get(memberName);
  if (!refreshed) return;
  if (refreshed.launchState === 'failed_to_start' || refreshed.launchState === 'confirmed_alive') {
    return;
  }
  const refreshedFirstSpawnAcceptedAt = refreshed.firstSpawnAcceptedAt;
  if (!refreshedFirstSpawnAcceptedAt) {
    return;
  }
  const runtimeByMember = await ports.getLiveTeamAgentRuntimeMetadata(run.teamName);
  if (!isCurrentMemberStatus(run, memberName, refreshed, ports)) return;
  const restartPending = run.pendingMemberRestarts.has(memberName);
  const metadata = resolveRuntimeMetadataForMember(runtimeByMember, memberName);
  const acceptedAtMs = Date.parse(refreshedFirstSpawnAcceptedAt);
  const elapsedMs = Number.isFinite(acceptedAtMs) ? ports.nowMs() - acceptedAtMs : Infinity;
  const runtimeDiagnostic = metadata?.runtimeDiagnostic;
  if (metadata?.livenessKind === 'runtime_process') {
    if (ports.isOpenCodeSecondaryLaneMemberInRun(run, memberName)) {
      const bootstrapStalled = elapsedMs >= MEMBER_BOOTSTRAP_STALL_MS;
      const guardedReconciliationPorts = guardOpenCodeReconciliationPorts(
        run,
        memberName,
        refreshed,
        firstSpawnAcceptedAt,
        ports
      );
      await reconcileOpenCodeRuntimeProcessBootstrapStatus(
        {
          run,
          memberName,
          current: refreshed,
          bootstrapStalled,
          runtimeDiagnostic,
          runtimeDiagnosticSeverity: metadata.runtimeDiagnosticSeverity,
          runtimeSessionId: metadata.runtimeSessionId,
          firstSpawnAcceptedAt: refreshedFirstSpawnAcceptedAt,
          scheduleReevaluation: !bootstrapStalled,
        },
        guardedReconciliationPorts
      );
      if (!isCurrentMemberLaunch(run, memberName, firstSpawnAcceptedAt, ports)) return;
      return;
    }
    if (!isCurrentMemberStatus(run, memberName, refreshed, ports)) return;
    ports.setMemberSpawnStatus(run, memberName, 'online', undefined, 'process');
    return;
  }
  if (metadata?.livenessKind === 'permission_blocked') {
    const next = {
      ...refreshed,
      livenessKind: metadata.livenessKind,
      runtimeDiagnostic: runtimeDiagnostic ?? 'waiting for permission approval',
      runtimeDiagnosticSeverity: metadata.runtimeDiagnosticSeverity ?? 'warning',
      livenessLastCheckedAt: ports.nowIso(),
      launchState: 'runtime_pending_permission' as const,
    };
    if (!isCurrentMemberStatus(run, memberName, refreshed, ports)) return;
    run.memberSpawnStatuses.set(memberName, next);
    if (!isCurrentMemberStatus(run, memberName, next, ports)) return;
    ports.emitMemberSpawnChange(run, memberName);
    return;
  }
  if (
    metadata?.livenessKind === 'runtime_process_candidate' &&
    elapsedMs < MEMBER_BOOTSTRAP_STALL_MS
  ) {
    const next = {
      ...refreshed,
      livenessKind: metadata.livenessKind,
      runtimeDiagnostic:
        runtimeDiagnostic ?? 'Runtime process candidate detected, but bootstrap is unconfirmed.',
      runtimeDiagnosticSeverity: metadata.runtimeDiagnosticSeverity ?? 'warning',
      livenessLastCheckedAt: ports.nowIso(),
    };
    if (!isCurrentMemberStatus(run, memberName, refreshed, ports)) return;
    run.memberSpawnStatuses.set(memberName, next);
    if (!isCurrentMemberStatus(run, memberName, next, ports)) return;
    ports.emitMemberSpawnChange(run, memberName);
    if (!isCurrentMemberStatus(run, memberName, next, ports)) return;
    ports.scheduleOpenCodeBootstrapStallReevaluation(
      run,
      memberName,
      refreshedFirstSpawnAcceptedAt
    );
    return;
  }
  const guardedStallPorts = guardOpenCodeReconciliationPorts(
    run,
    memberName,
    refreshed,
    firstSpawnAcceptedAt,
    ports
  );
  const markedStalled = await markOpenCodeSecondaryBootstrapStalled(
    {
      run,
      memberName,
      current: refreshed,
      isOpenCodeSecondaryLaneMember: ports.isOpenCodeSecondaryLaneMemberInRun(run, memberName),
      bootstrapStallWindowElapsed: elapsedMs >= MEMBER_BOOTSTRAP_STALL_MS,
      runtimeMetadata: metadata,
    },
    guardedStallPorts
  );
  if (!isCurrentMemberLaunch(run, memberName, firstSpawnAcceptedAt, ports)) return;
  if (markedStalled) return;
  if (!isCurrentMemberStatus(run, memberName, refreshed, ports)) return;
  const strictReason = restartPending
    ? buildRestartGraceTimeoutReason(memberName)
    : (runtimeDiagnostic ??
      (metadata?.livenessKind === 'shell_only'
        ? 'Tmux pane is alive, but no teammate runtime process was found.'
        : 'Teammate did not join within the launch grace window.'));
  if (restartPending) {
    if (!isCurrentMemberStatus(run, memberName, refreshed, ports)) return;
    run.pendingMemberRestarts.delete(memberName);
  }
  const livenessObservedAt = ports.nowIso();
  const nextRuntimeLostStatus: MemberSpawnStatusEntry = {
    ...refreshed,
    runtimeAlive: false,
    livenessSource: undefined,
    bootstrapConfirmed: false,
    ...(metadata?.livenessKind ? { livenessKind: metadata.livenessKind } : {}),
    ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
    ...(metadata?.runtimeDiagnosticSeverity
      ? { runtimeDiagnosticSeverity: metadata.runtimeDiagnosticSeverity }
      : {}),
    livenessLastCheckedAt: livenessObservedAt,
  };
  if (!isCurrentMemberStatus(run, memberName, refreshed, ports)) return;
  ports.syncMemberTaskActivityForRuntimeTransition(
    run,
    memberName,
    refreshed,
    nextRuntimeLostStatus,
    livenessObservedAt
  );
  if (!isCurrentMemberStatus(run, memberName, refreshed, ports)) return;
  run.memberSpawnStatuses.set(memberName, nextRuntimeLostStatus);
  if (!isCurrentMemberStatus(run, memberName, nextRuntimeLostStatus, ports)) return;
  ports.setMemberSpawnStatus(run, memberName, 'error', strictReason);
}
