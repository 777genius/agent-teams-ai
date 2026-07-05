import { getErrorMessage } from '@shared/utils/errorHandling';

import {
  applyPrimaryBootstrapTruthToLaunchReportingSnapshot,
  overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState,
  type PrimaryBootstrapTruthReportingPorts,
  type PrimaryBootstrapTruthRunLike,
} from './TeamProvisioningPrimaryBootstrapTruthReporting';

import type { MemberSpawnStatusEntry, PersistedTeamLaunchSnapshot } from '@shared/types';

export interface TeamProvisioningPrimaryBootstrapTruthReportingServiceAdapter<
  TRun extends PrimaryBootstrapTruthRunLike,
> {
  isOpenCodeSecondaryLaneMemberInRun(run: TRun, memberName: string): boolean;
  syncMemberTaskActivityForRuntimeTransition(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry,
    observedAt: string
  ): void;
  syncMemberLaunchGraceCheck(run: TRun, memberName: string, next: MemberSpawnStatusEntry): void;
  syncRunMemberSpawnStatusesFromSnapshot(run: TRun, snapshot: PersistedTeamLaunchSnapshot): void;
}

export interface TeamProvisioningPrimaryBootstrapTruthReportingPortsFactoryDeps<
  TRun extends PrimaryBootstrapTruthRunLike,
> {
  service: TeamProvisioningPrimaryBootstrapTruthReportingServiceAdapter<TRun>;
  readBootstrapLaunchSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<PersistedTeamLaunchSnapshot>;
  nowIso(): string;
  logger: {
    warn(message: string): void;
  };
}

export interface TeamProvisioningPrimaryBootstrapTruthReportingBoundary<
  TRun extends PrimaryBootstrapTruthRunLike,
> {
  overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(run: TRun): Promise<void>;
  applyPrimaryBootstrapTruthToLaunchReportingSnapshot(
    run: TRun,
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  reconcileFinalLaunchReportingSnapshot(
    run: TRun,
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null>;
}

function createPrimaryBootstrapTruthReportingPorts<TRun extends PrimaryBootstrapTruthRunLike>(
  deps: TeamProvisioningPrimaryBootstrapTruthReportingPortsFactoryDeps<TRun>
): PrimaryBootstrapTruthReportingPorts<TRun> {
  return {
    readBootstrapLaunchSnapshot: (teamName) => deps.readBootstrapLaunchSnapshot(teamName),
    nowIso: () => deps.nowIso(),
    isOpenCodeSecondaryLaneMemberInRun: (run, memberName) =>
      deps.service.isOpenCodeSecondaryLaneMemberInRun(run, memberName),
    syncMemberTaskActivityForRuntimeTransition: (run, memberName, previous, next, observedAt) =>
      deps.service.syncMemberTaskActivityForRuntimeTransition(
        run,
        memberName,
        previous,
        next,
        observedAt
      ),
    syncMemberLaunchGraceCheck: (run, memberName, next) =>
      deps.service.syncMemberLaunchGraceCheck(run, memberName, next),
  };
}

export function createTeamProvisioningPrimaryBootstrapTruthReportingBoundary<
  TRun extends PrimaryBootstrapTruthRunLike,
>(
  deps: TeamProvisioningPrimaryBootstrapTruthReportingPortsFactoryDeps<TRun>
): TeamProvisioningPrimaryBootstrapTruthReportingBoundary<TRun> {
  const reportingPorts = createPrimaryBootstrapTruthReportingPorts(deps);

  return {
    overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState: (run) =>
      overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(run, reportingPorts),
    applyPrimaryBootstrapTruthToLaunchReportingSnapshot: (run, snapshot) =>
      applyPrimaryBootstrapTruthToLaunchReportingSnapshot(run, snapshot, reportingPorts),
    async reconcileFinalLaunchReportingSnapshot(run, snapshot) {
      const reconciled = await applyPrimaryBootstrapTruthToLaunchReportingSnapshot(
        run,
        snapshot,
        reportingPorts
      );
      if (!reconciled || reconciled === snapshot) {
        return reconciled;
      }
      deps.service.syncRunMemberSpawnStatusesFromSnapshot(run, reconciled);
      try {
        return await deps.writeLaunchStateSnapshot(run.teamName, reconciled);
      } catch (error) {
        deps.logger.warn(
          `[${run.teamName}] Failed to persist reconciled launch reporting snapshot: ${getErrorMessage(
            error
          )}`
        );
        return reconciled;
      }
    },
  };
}
