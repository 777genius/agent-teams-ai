import type { MemberSpawnStatusEntry } from '@shared/types';

export interface TeamProvisioningBootstrapFailureMarkingRun {
  teamName: string;
  expectedMembers: string[];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  pendingMemberRestarts?: {
    has(memberName: string): boolean;
  };
}

export interface MarkUnconfirmedBootstrapMembersFailedOptions {
  cleanupRequested?: boolean;
  preserveExistingFailure?: boolean;
}

export interface TeamProvisioningBootstrapFailureMarkingPorts<
  TRun extends TeamProvisioningBootstrapFailureMarkingRun,
> {
  nowIso(): string;
  createInitialMemberSpawnStatusEntry(): MemberSpawnStatusEntry;
  isMemberLifecycleOperationActive(teamName: string, memberName: string): boolean;
  syncMemberTaskActivityForRuntimeTransition(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry,
    observedAt: string
  ): void;
  appendMemberBootstrapDiagnostic(run: TRun, memberName: string, detail: string): void;
  isCurrentTrackedRun(run: TRun): boolean;
  emitMemberSpawnChange(run: TRun, memberName: string): void;
}

export interface TeamProvisioningBootstrapFailureMarker<
  TRun extends TeamProvisioningBootstrapFailureMarkingRun,
> {
  markUnconfirmedBootstrapMembersFailed(
    run: TRun,
    reason: string,
    options?: MarkUnconfirmedBootstrapMembersFailedOptions
  ): void;
}

export function createTeamProvisioningBootstrapFailureMarker<
  TRun extends TeamProvisioningBootstrapFailureMarkingRun,
>(
  ports: TeamProvisioningBootstrapFailureMarkingPorts<TRun>
): TeamProvisioningBootstrapFailureMarker<TRun> {
  return {
    markUnconfirmedBootstrapMembersFailed(run, reason, options) {
      const failedAt = ports.nowIso();
      const baseReason =
        reason.trim() || 'Deterministic bootstrap failed before teammate check-in.';
      for (const expected of run.expectedMembers) {
        const prev =
          run.memberSpawnStatuses.get(expected) ?? ports.createInitialMemberSpawnStatusEntry();
        if (prev.bootstrapConfirmed || prev.skippedForLaunch) {
          continue;
        }
        if (ports.isMemberLifecycleOperationActive(run.teamName, expected)) {
          continue;
        }
        if (run.pendingMemberRestarts?.has(expected) === true) {
          continue;
        }
        const hasExistingTerminalFailure =
          prev.status === 'error' ||
          prev.launchState === 'failed_to_start' ||
          prev.hardFailure === true ||
          Boolean(prev.hardFailureReason);
        const preservedFailureReason =
          options?.preserveExistingFailure && hasExistingTerminalFailure
            ? (prev.hardFailureReason ?? prev.error)?.trim()
            : undefined;

        const runtimeWasAlive = prev.runtimeAlive === true || prev.livenessSource === 'process';
        const fallbackFailureReason = runtimeWasAlive
          ? `${baseReason} Runtime process was alive after bootstrap failure${
              options?.cleanupRequested ? '; launch-owned cleanup requested.' : '.'
            }`
          : baseReason;
        const hardFailureReason = preservedFailureReason || fallbackFailureReason;
        const next: MemberSpawnStatusEntry = {
          ...prev,
          status: 'error',
          updatedAt: failedAt,
          error: hardFailureReason,
          hardFailure: true,
          hardFailureReason,
          bootstrapConfirmed: false,
          bootstrapStalled: undefined,
          runtimeAlive: options?.cleanupRequested ? false : prev.runtimeAlive,
          livenessSource: options?.cleanupRequested ? undefined : prev.livenessSource,
          runtimeDiagnostic: runtimeWasAlive
            ? options?.cleanupRequested
              ? 'Bootstrap failed before teammate check-in; launch-owned runtime cleanup requested.'
              : 'Bootstrap failed before teammate check-in while runtime process was still alive.'
            : prev.runtimeDiagnostic,
          runtimeDiagnosticSeverity: runtimeWasAlive ? 'warning' : prev.runtimeDiagnosticSeverity,
          launchState: 'failed_to_start',
        };

        ports.syncMemberTaskActivityForRuntimeTransition(run, expected, prev, next, failedAt);
        run.memberSpawnStatuses.set(expected, next);
        ports.appendMemberBootstrapDiagnostic(run, expected, hardFailureReason);
        if (ports.isCurrentTrackedRun(run)) {
          ports.emitMemberSpawnChange(run, expected);
        }
      }
    },
  };
}
