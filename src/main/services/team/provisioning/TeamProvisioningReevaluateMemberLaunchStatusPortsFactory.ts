import {
  reevaluateMemberLaunchStatus,
  type ReevaluateMemberLaunchStatusPorts,
  type ReevaluateMemberLaunchStatusRunLike,
} from './TeamProvisioningReevaluateMemberLaunchStatus';

import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type {
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
} from '@shared/types';

export interface TeamProvisioningReevaluateMemberLaunchStatusServiceAdapter<
  TRun extends ReevaluateMemberLaunchStatusRunLike,
> {
  refreshMemberSpawnStatusesFromLeadInbox(run: TRun): Promise<void>;
  maybeAuditMemberSpawnStatuses(run: TRun, options: { force: true }): Promise<void>;
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>>;
  isOpenCodeSecondaryLaneMemberInRun(run: TRun, memberName: string): boolean;
  getOpenCodeBootstrapStallReconciliationPorts(): ReevaluateMemberLaunchStatusPorts<TRun>['reconcileOpenCodeBootstrapStallPorts'];
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

export interface TeamProvisioningReevaluateMemberLaunchStatusPortsFactoryDeps<
  TRun extends ReevaluateMemberLaunchStatusRunLike,
> {
  nowIso(): string;
  nowMs(): number;
  service: TeamProvisioningReevaluateMemberLaunchStatusServiceAdapter<TRun>;
}

export interface TeamProvisioningReevaluateMemberLaunchStatusBoundary<
  TRun extends ReevaluateMemberLaunchStatusRunLike,
> {
  createPorts(): ReevaluateMemberLaunchStatusPorts<TRun>;
  reevaluateMemberLaunchStatus(run: TRun, memberName: string): Promise<void>;
}

export function createTeamProvisioningReevaluateMemberLaunchStatusPorts<
  TRun extends ReevaluateMemberLaunchStatusRunLike,
>(
  deps: TeamProvisioningReevaluateMemberLaunchStatusPortsFactoryDeps<TRun>
): ReevaluateMemberLaunchStatusPorts<TRun> {
  return {
    nowIso: deps.nowIso,
    nowMs: deps.nowMs,
    refreshMemberSpawnStatusesFromLeadInbox: (run) =>
      deps.service.refreshMemberSpawnStatusesFromLeadInbox(run),
    maybeAuditMemberSpawnStatuses: (run, options) =>
      deps.service.maybeAuditMemberSpawnStatuses(run, options),
    getLiveTeamAgentRuntimeMetadata: (teamName) =>
      deps.service.getLiveTeamAgentRuntimeMetadata(teamName),
    isOpenCodeSecondaryLaneMemberInRun: (run, memberName) =>
      deps.service.isOpenCodeSecondaryLaneMemberInRun(run, memberName),
    reconcileOpenCodeBootstrapStallPorts:
      deps.service.getOpenCodeBootstrapStallReconciliationPorts(),
    setMemberSpawnStatus: (run, memberName, status, error, livenessSource) =>
      deps.service.setMemberSpawnStatus(run, memberName, status, error, livenessSource),
    emitMemberSpawnChange: (run, memberName) => deps.service.emitMemberSpawnChange(run, memberName),
    scheduleOpenCodeBootstrapStallReevaluation: (run, memberName, firstSpawnAcceptedAt) =>
      deps.service.scheduleOpenCodeBootstrapStallReevaluation(
        run,
        memberName,
        firstSpawnAcceptedAt
      ),
    syncMemberTaskActivityForRuntimeTransition: (run, memberName, previous, next, observedAt) =>
      deps.service.syncMemberTaskActivityForRuntimeTransition(
        run,
        memberName,
        previous,
        next,
        observedAt
      ),
  };
}

export function createTeamProvisioningReevaluateMemberLaunchStatusBoundary<
  TRun extends ReevaluateMemberLaunchStatusRunLike,
>(
  deps: TeamProvisioningReevaluateMemberLaunchStatusPortsFactoryDeps<TRun>
): TeamProvisioningReevaluateMemberLaunchStatusBoundary<TRun> {
  return {
    createPorts: () => createTeamProvisioningReevaluateMemberLaunchStatusPorts(deps),
    reevaluateMemberLaunchStatus: (run, memberName) =>
      reevaluateMemberLaunchStatus(
        run,
        memberName,
        createTeamProvisioningReevaluateMemberLaunchStatusPorts(deps)
      ),
  };
}
