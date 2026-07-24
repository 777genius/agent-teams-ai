import { type TeamRuntimeLaneCoordinator } from '@features/team-runtime-lanes/main';
import { createLogger } from '@shared/utils/logger';

import { type TeamProvisioningBootstrapEvidenceFacade } from './TeamProvisioningBootstrapEvidenceFacade';
import { type TeamProvisioningLaunchNotifications } from './TeamProvisioningLaunchNotifications';
import {
  buildAggregatePendingLaunchMessage as buildAggregatePendingLaunchMessageHelper,
  hasPendingLaunchMembers as hasPendingLaunchMembersHelper,
} from './TeamProvisioningLaunchPendingMessage';
import {
  areAllExpectedLaunchMembersConfirmed as areAllExpectedLaunchMembersConfirmedHelper,
  getMemberLaunchSummary as getMemberLaunchSummaryHelper,
  hasMixedLaunchMetadata,
  hasMixedSecondaryLaunchMetadata,
  hasPrimaryOnlyLaneAwareLaunchMetadata,
} from './TeamProvisioningLaunchStateProjection';
import {
  finalizeMissingRegisteredMembersAsFailed as finalizeMissingRegisteredMembersAsFailedHelper,
  type OpenCodeSecondaryEvidenceOverlayParams,
} from './TeamProvisioningLaunchStateReconciliation';
import {
  type LaunchStateWriteOptions,
  type LaunchStateWriteResult,
  type PendingOpenCodePrimaryCleanup,
} from './TeamProvisioningLaunchStateStoreBoundary';
import { type TeamProvisioningLiveLaunchSnapshotBoundary } from './TeamProvisioningLiveLaunchSnapshotBoundaryFactory';
import { MEMBER_LAUNCH_GRACE_MS } from './TeamProvisioningMemberSpawnStatusPolicy';
import { buildRuntimeSpawnStatusRecord as buildRuntimeSpawnStatusRecordHelper } from './TeamProvisioningMemberStatusProjection';
import { type TeamProvisioningMixedSecondaryLaneWiring } from './TeamProvisioningMixedSecondaryLaneWiring';
import {
  buildMixedSecondaryLaunchSnapshotForRun as buildMixedSecondaryLaunchSnapshotForRunHelper,
  shouldRecoverStalePersistedMixedLaunchSnapshot as shouldRecoverStalePersistedMixedLaunchSnapshotHelper,
} from './TeamProvisioningMixedSecondaryLaunchReconciliation';
import {
  applyOpenCodeSecondaryBootstrapStallOverlay as applyOpenCodeSecondaryBootstrapStallOverlayHelper,
  getOpenCodeSecondaryBootstrapPendingMemberNames as getOpenCodeSecondaryBootstrapPendingMemberNamesHelper,
  isRecoverablePersistedOpenCodeTerminalRuntimeCandidate,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { type PersistedLaunchReconciliationResult } from './TeamProvisioningPersistedLaunchReconciliation';
import { type TeamProvisioningPersistenceReconcileFacade } from './TeamProvisioningPersistenceReconcileFacade';
import { type TeamProvisioningPrimaryBootstrapTruthReportingBoundary } from './TeamProvisioningPrimaryBootstrapTruthReportingPortsFactory';
import {
  auditRegisteredMemberSpawnStatusesWithService,
  type AuditRegisteredMemberSpawnStatusServiceHost,
  readRegisteredTeamMemberNamesFromConfigDefaults,
} from './TeamProvisioningRegisteredMemberAudit';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { nowIso } from './TeamProvisioningRunProgress';
import { type LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import { TeamProvisioningStopCleanupCompatibilityFacade } from './TeamProvisioningStopCleanupCompatibilityFacade';

import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  PersistedTeamLaunchSummary,
  TeamMember,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export interface TeamProvisioningLaunchSummaryLike {
  confirmedCount: number;
  pendingCount: number;
  failedCount: number;
  skippedCount?: number;
  runtimeAlivePendingCount: number;
  shellOnlyPendingCount?: number;
  runtimeProcessPendingCount?: number;
  runtimeCandidatePendingCount?: number;
  noRuntimePendingCount?: number;
  permissionPendingCount?: number;
}

export interface TeamProvisioningLaunchStateCompatibilityBoundary<
  TRun extends ProvisioningRun = ProvisioningRun,
> {
  getRegisteredTeamMemberNames(teamName: string): Promise<Set<string> | null>;
  auditMemberSpawnStatuses(run: TRun): Promise<void>;
  finalizeMissingRegisteredMembersAsFailed(run: TRun): Promise<void>;
  getOpenCodeSecondaryBootstrapPendingMemberNames(
    snapshot: PersistedTeamLaunchSnapshot | null | undefined
  ): ReadonlySet<string>;
  applyOpenCodeSecondaryBootstrapStallOverlay(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): PersistedTeamLaunchSnapshot | null;
  getLiveTeamAgentNames(teamName: string): Promise<Set<string>>;
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
  clearPersistedLaunchState(teamName: string, options?: { expectedRunId?: string }): Promise<void>;
  canClearPersistedLaunchStateForRun(teamName: string, expectedRunId: string | undefined): boolean;
  clearPersistedLaunchStateNow(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void>;
  applyOpenCodeSecondaryEvidenceOverlay(
    params: OpenCodeSecondaryEvidenceOverlayParams & {
      metaMembers?: readonly TeamMember[];
    }
  ): Promise<PersistedTeamLaunchSnapshot>;
  writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: LaunchStateWriteOptions
  ): Promise<PersistedTeamLaunchSnapshot>;
  writeLaunchStateSnapshotNow(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: LaunchStateWriteOptions
  ): Promise<LaunchStateWriteResult>;
  isLaunchStateNoopRefreshDue(snapshot: PersistedTeamLaunchSnapshot): boolean;
  readPendingOpenCodePrimaryCleanups(teamId: string): Promise<PendingOpenCodePrimaryCleanup[]>;
  appendPendingOpenCodePrimaryCleanup(cleanup: PendingOpenCodePrimaryCleanup): Promise<void>;
  consumePendingOpenCodePrimaryCleanup(cleanup: PendingOpenCodePrimaryCleanup): Promise<boolean>;
  enqueueLaunchStateStoreOperation<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  getMemberLaunchSummary(run: TRun): PersistedTeamLaunchSummary;
  buildAggregatePendingLaunchMessage(
    prefix: string,
    run: TRun,
    launchSummary: TeamProvisioningLaunchSummaryLike,
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): string;
  buildRuntimeSpawnStatusRecord(run: TRun): Record<string, MemberSpawnStatusEntry>;
  reconcileFinalLaunchReportingSnapshot(
    run: TRun,
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  syncRunMemberSpawnStatusesFromSnapshot(run: TRun, snapshot: PersistedTeamLaunchSnapshot): void;
  hasPendingLaunchMembers(
    run: TRun,
    launchSummary: { pendingCount: number },
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): boolean;
  buildLiveLaunchSnapshotForRun(
    run: TRun,
    launchPhase?: PersistedTeamLaunchPhase
  ): PersistedTeamLaunchSnapshot | null;
  emitMemberSpawnChange(run: Pick<TRun, 'teamName' | 'runId'>, memberName: string): void;
  maybeFireTeamLaunchedNotificationWhenAllMembersJoined(run: TRun): Promise<void>;
  areAllExpectedLaunchMembersConfirmed(run: TRun): boolean;
  buildMixedPersistedLaunchSnapshotForRun(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase
  ): PersistedTeamLaunchSnapshot | null;
  hasMixedLaunchMetadata(snapshot: PersistedTeamLaunchSnapshot | null): boolean;
  hasMixedSecondaryLaunchMetadata(snapshot: PersistedTeamLaunchSnapshot | null): boolean;
  hasPrimaryOnlyLaneAwareLaunchMetadata(snapshot: PersistedTeamLaunchSnapshot | null): boolean;
  shouldRecoverStalePersistedMixedLaunchSnapshot(snapshot: PersistedTeamLaunchSnapshot): boolean;
  persistLaunchStateSnapshot(
    run: TRun,
    launchPhase?: PersistedTeamLaunchPhase
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  persistLaunchStateSnapshotNow(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  recoverStaleMixedSecondaryLaunchSnapshot(
    teamName: string,
    bootstrapSnapshot: PersistedTeamLaunchSnapshot | null,
    persistedSnapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  reconcilePersistedLaunchState(teamName: string): Promise<PersistedLaunchReconciliationResult>;
  fireTeamLaunchedNotification(run: TRun): Promise<void>;
  fireTeamLaunchIncompleteNotification(
    run: TRun,
    failedMembers: readonly { name: string }[],
    launchSummary: TeamProvisioningLaunchSummaryLike,
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): Promise<void>;
}

export interface TeamProvisioningLaunchStateCompatibilityServiceHost<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends AuditRegisteredMemberSpawnStatusServiceHost<TRun> {
  liveRuntimeMetadataPorts: {
    getLiveTeamAgentRuntimeMetadata(
      teamName: string
    ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
  };
  persistenceReconcileFacade: Pick<
    TeamProvisioningPersistenceReconcileFacade<TRun>,
    | 'clearPersistedLaunchState'
    | 'canClearPersistedLaunchStateForRun'
    | 'clearPersistedLaunchStateNow'
    | 'writeLaunchStateSnapshot'
    | 'writeLaunchStateSnapshotNow'
    | 'isLaunchStateNoopRefreshDue'
    | 'readPendingOpenCodePrimaryCleanups'
    | 'appendPendingOpenCodePrimaryCleanup'
    | 'consumePendingOpenCodePrimaryCleanup'
    | 'enqueueLaunchStateStoreOperation'
    | 'persistLaunchStateSnapshot'
    | 'persistLaunchStateSnapshotNow'
    | 'reconcilePersistedLaunchState'
  >;
  bootstrapEvidenceFacade: Pick<
    TeamProvisioningBootstrapEvidenceFacade,
    'applyOpenCodeSecondaryEvidenceOverlay'
  >;
  primaryBootstrapTruthReporting: Pick<
    TeamProvisioningPrimaryBootstrapTruthReportingBoundary<TRun>,
    'reconcileFinalLaunchReportingSnapshot'
  >;
  liveLaunchSnapshotBoundary: TeamProvisioningLiveLaunchSnapshotBoundary<TRun>;
  launchNotifications: Pick<
    TeamProvisioningLaunchNotifications<TRun>,
    'fireTeamLaunchedNotification' | 'fireTeamLaunchIncompleteNotification'
  >;
  mixedSecondaryLaneWiring: Pick<
    TeamProvisioningMixedSecondaryLaneWiring<TRun>,
    'recoverStaleMixedSecondaryLaunchSnapshot'
  >;
  runtimeLaneCoordinator: Pick<TeamRuntimeLaneCoordinator, 'buildAggregateLaunchSnapshot'>;
  isProvisioningRunPromotedToAlive(run: TRun): boolean;
  isMemberLifecycleOperationActive(teamName: string, memberName: string): boolean;
}

export function createTeamProvisioningLaunchStateCompatibilityBoundaryFromService<
  TRun extends ProvisioningRun,
>(
  service: TeamProvisioningLaunchStateCompatibilityServiceHost<TRun>
): TeamProvisioningLaunchStateCompatibilityBoundary<TRun> {
  const getLiveRuntimeMetadata = (teamName: string) => {
    const serviceWithLegacyOverride = service as unknown as {
      getLiveTeamAgentRuntimeMetadata?: (
        teamName: string
      ) => Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
    };
    const ownOverride = Object.prototype.hasOwnProperty.call(
      serviceWithLegacyOverride,
      'getLiveTeamAgentRuntimeMetadata'
    );
    if (
      ownOverride &&
      typeof serviceWithLegacyOverride.getLiveTeamAgentRuntimeMetadata === 'function'
    ) {
      return serviceWithLegacyOverride.getLiveTeamAgentRuntimeMetadata(teamName);
    }
    return service.liveRuntimeMetadataPorts.getLiveTeamAgentRuntimeMetadata(teamName);
  };
  return {
    getRegisteredTeamMemberNames(teamName) {
      return readRegisteredTeamMemberNamesFromConfigDefaults(teamName);
    },

    auditMemberSpawnStatuses(run) {
      return auditRegisteredMemberSpawnStatusesWithService<TRun>(run, service, {
        debug: (message) => logger.debug(message),
        warn: (message) => logger.warn(message),
      });
    },

    finalizeMissingRegisteredMembersAsFailed(run) {
      return finalizeMissingRegisteredMembersAsFailedHelper(run, {
        getRegisteredTeamMemberNames: (teamName) => service.getRegisteredTeamMemberNames(teamName),
        isMemberLifecycleOperationActive: (teamName, memberName) =>
          service.isMemberLifecycleOperationActive(teamName, memberName),
        setMemberSpawnStatus: (targetRun, memberName, status, error) =>
          service.setMemberSpawnStatus(targetRun, memberName, status, error),
      });
    },

    getOpenCodeSecondaryBootstrapPendingMemberNames(snapshot) {
      return getOpenCodeSecondaryBootstrapPendingMemberNamesHelper(snapshot);
    },

    applyOpenCodeSecondaryBootstrapStallOverlay(snapshot) {
      return applyOpenCodeSecondaryBootstrapStallOverlayHelper(snapshot, {
        nowMs: Date.now(),
        updatedAt: nowIso(),
      });
    },

    async getLiveTeamAgentNames(teamName) {
      const runtimeByMember = await getLiveRuntimeMetadata(teamName);
      return new Set(
        [...runtimeByMember.entries()]
          .filter(([, metadata]) => metadata.alive)
          .map(([memberName]) => memberName)
      );
    },

    getLiveTeamAgentRuntimeMetadata(teamName) {
      return getLiveRuntimeMetadata(teamName);
    },

    clearPersistedLaunchState(teamName, options) {
      return service.persistenceReconcileFacade.clearPersistedLaunchState(teamName, options);
    },

    canClearPersistedLaunchStateForRun(teamName, expectedRunId) {
      return service.persistenceReconcileFacade.canClearPersistedLaunchStateForRun(
        teamName,
        expectedRunId
      );
    },

    clearPersistedLaunchStateNow(teamName, options) {
      return service.persistenceReconcileFacade.clearPersistedLaunchStateNow(teamName, options);
    },

    applyOpenCodeSecondaryEvidenceOverlay(params) {
      return service.bootstrapEvidenceFacade.applyOpenCodeSecondaryEvidenceOverlay(params);
    },

    writeLaunchStateSnapshot(teamName, snapshot, options) {
      return options === undefined
        ? service.persistenceReconcileFacade.writeLaunchStateSnapshot(teamName, snapshot)
        : service.persistenceReconcileFacade.writeLaunchStateSnapshot(teamName, snapshot, options);
    },

    writeLaunchStateSnapshotNow(teamName, snapshot, options) {
      return service.persistenceReconcileFacade.writeLaunchStateSnapshotNow(
        teamName,
        snapshot,
        options
      );
    },

    isLaunchStateNoopRefreshDue(snapshot) {
      return service.persistenceReconcileFacade.isLaunchStateNoopRefreshDue(snapshot);
    },

    readPendingOpenCodePrimaryCleanups(teamId) {
      return service.persistenceReconcileFacade.readPendingOpenCodePrimaryCleanups(teamId);
    },

    appendPendingOpenCodePrimaryCleanup(cleanup) {
      return service.persistenceReconcileFacade.appendPendingOpenCodePrimaryCleanup(cleanup);
    },

    consumePendingOpenCodePrimaryCleanup(cleanup) {
      return service.persistenceReconcileFacade.consumePendingOpenCodePrimaryCleanup(cleanup);
    },

    enqueueLaunchStateStoreOperation(teamName, operation) {
      return service.persistenceReconcileFacade.enqueueLaunchStateStoreOperation(
        teamName,
        operation
      );
    },

    getMemberLaunchSummary(run) {
      return getMemberLaunchSummaryHelper(run);
    },

    buildAggregatePendingLaunchMessage(prefix, run, launchSummary, snapshot) {
      return buildAggregatePendingLaunchMessageHelper({
        prefix,
        run,
        launchSummary,
        snapshot,
      });
    },

    buildRuntimeSpawnStatusRecord(run) {
      return buildRuntimeSpawnStatusRecordHelper(run);
    },

    reconcileFinalLaunchReportingSnapshot(run, snapshot) {
      return service.primaryBootstrapTruthReporting.reconcileFinalLaunchReportingSnapshot(
        run,
        snapshot
      );
    },

    syncRunMemberSpawnStatusesFromSnapshot(run, snapshot) {
      service.liveLaunchSnapshotBoundary.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);
    },

    hasPendingLaunchMembers(run, launchSummary, snapshot) {
      return hasPendingLaunchMembersHelper({ run, launchSummary, snapshot });
    },

    buildLiveLaunchSnapshotForRun(run, launchPhase) {
      return service.liveLaunchSnapshotBoundary.buildLiveLaunchSnapshotForRun(run, launchPhase);
    },

    emitMemberSpawnChange(run, memberName) {
      service.liveLaunchSnapshotBoundary.emitMemberSpawnChange(run, memberName);
    },

    async maybeFireTeamLaunchedNotificationWhenAllMembersJoined(run) {
      if (
        !run.isLaunch ||
        run.teamLaunchedNotificationFired ||
        run.processKilled ||
        run.cancelRequested ||
        !service.isProvisioningRunPromotedToAlive(run) ||
        !areAllExpectedLaunchMembersConfirmedHelper(run)
      ) {
        return;
      }

      await service.launchNotifications.fireTeamLaunchedNotification(run);
    },

    areAllExpectedLaunchMembersConfirmed(run) {
      return areAllExpectedLaunchMembersConfirmedHelper(run);
    },

    buildMixedPersistedLaunchSnapshotForRun(run, launchPhase) {
      return buildMixedSecondaryLaunchSnapshotForRunHelper(run, launchPhase, {
        buildRuntimeSpawnStatusRecord: (inputRun) => buildRuntimeSpawnStatusRecordHelper(inputRun),
        buildAggregateLaunchSnapshot: (params) =>
          service.runtimeLaneCoordinator.buildAggregateLaunchSnapshot(params),
      });
    },

    hasMixedLaunchMetadata(snapshot) {
      return hasMixedLaunchMetadata(snapshot);
    },

    hasMixedSecondaryLaunchMetadata(snapshot) {
      return hasMixedSecondaryLaunchMetadata(snapshot);
    },

    hasPrimaryOnlyLaneAwareLaunchMetadata(snapshot) {
      return hasPrimaryOnlyLaneAwareLaunchMetadata(snapshot);
    },

    shouldRecoverStalePersistedMixedLaunchSnapshot(snapshot) {
      return shouldRecoverStalePersistedMixedLaunchSnapshotHelper({
        snapshot,
        nowMs: Date.now(),
        graceMs: MEMBER_LAUNCH_GRACE_MS,
        isRecoverablePersistedOpenCodeTerminalRuntimeCandidate,
      });
    },

    persistLaunchStateSnapshot(run, launchPhase) {
      return service.persistenceReconcileFacade.persistLaunchStateSnapshot(run, launchPhase);
    },

    persistLaunchStateSnapshotNow(run, launchPhase) {
      return service.persistenceReconcileFacade.persistLaunchStateSnapshotNow(run, launchPhase);
    },

    recoverStaleMixedSecondaryLaunchSnapshot(teamName, bootstrapSnapshot, persistedSnapshot) {
      return service.mixedSecondaryLaneWiring.recoverStaleMixedSecondaryLaunchSnapshot(
        teamName,
        bootstrapSnapshot,
        persistedSnapshot
      );
    },

    reconcilePersistedLaunchState(teamName) {
      return service.persistenceReconcileFacade.reconcilePersistedLaunchState(teamName);
    },

    fireTeamLaunchedNotification(run) {
      return service.launchNotifications.fireTeamLaunchedNotification(run);
    },

    fireTeamLaunchIncompleteNotification(run, failedMembers, launchSummary, snapshot) {
      return service.launchNotifications.fireTeamLaunchIncompleteNotification(
        run,
        failedMembers,
        launchSummary,
        snapshot
      );
    },
  };
}

export abstract class TeamProvisioningLaunchStateCompatibilityFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningStopCleanupCompatibilityFacade<TRun> {
  protected abstract readonly launchStateCompatibilityBoundary: TeamProvisioningLaunchStateCompatibilityBoundary<TRun>;

  protected getRegisteredTeamMemberNames(teamName: string): Promise<Set<string> | null> {
    return this.launchStateCompatibilityBoundary.getRegisteredTeamMemberNames(teamName);
  }

  protected auditMemberSpawnStatuses(run: TRun): Promise<void> {
    return this.launchStateCompatibilityBoundary.auditMemberSpawnStatuses(run);
  }

  protected finalizeMissingRegisteredMembersAsFailed(run: TRun): Promise<void> {
    return this.launchStateCompatibilityBoundary.finalizeMissingRegisteredMembersAsFailed(run);
  }

  protected getOpenCodeSecondaryBootstrapPendingMemberNames(
    snapshot: PersistedTeamLaunchSnapshot | null | undefined
  ): ReadonlySet<string> {
    return this.launchStateCompatibilityBoundary.getOpenCodeSecondaryBootstrapPendingMemberNames(
      snapshot
    );
  }

  protected applyOpenCodeSecondaryBootstrapStallOverlay(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): PersistedTeamLaunchSnapshot | null {
    return this.launchStateCompatibilityBoundary.applyOpenCodeSecondaryBootstrapStallOverlay(
      snapshot
    );
  }

  protected getLiveTeamAgentNames(teamName: string): Promise<Set<string>> {
    return this.launchStateCompatibilityBoundary.getLiveTeamAgentNames(teamName);
  }

  protected getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
    return this.launchStateCompatibilityBoundary.getLiveTeamAgentRuntimeMetadata(teamName);
  }

  protected clearPersistedLaunchState(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void> {
    return this.launchStateCompatibilityBoundary.clearPersistedLaunchState(teamName, options);
  }

  protected canClearPersistedLaunchStateForRun(
    teamName: string,
    expectedRunId: string | undefined
  ): boolean {
    return this.launchStateCompatibilityBoundary.canClearPersistedLaunchStateForRun(
      teamName,
      expectedRunId
    );
  }

  protected clearPersistedLaunchStateNow(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void> {
    return this.launchStateCompatibilityBoundary.clearPersistedLaunchStateNow(teamName, options);
  }

  protected applyOpenCodeSecondaryEvidenceOverlay(params: {
    teamName: string;
    snapshot: PersistedTeamLaunchSnapshot;
    previousSnapshot?: PersistedTeamLaunchSnapshot | null;
    metaMembers?: readonly TeamMember[];
  }): Promise<PersistedTeamLaunchSnapshot> {
    return this.launchStateCompatibilityBoundary.applyOpenCodeSecondaryEvidenceOverlay(params);
  }

  protected writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: LaunchStateWriteOptions
  ): Promise<PersistedTeamLaunchSnapshot> {
    return options === undefined
      ? this.launchStateCompatibilityBoundary.writeLaunchStateSnapshot(teamName, snapshot)
      : this.launchStateCompatibilityBoundary.writeLaunchStateSnapshot(teamName, snapshot, options);
  }

  protected writeLaunchStateSnapshotNow(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: LaunchStateWriteOptions
  ): Promise<LaunchStateWriteResult> {
    return this.launchStateCompatibilityBoundary.writeLaunchStateSnapshotNow(
      teamName,
      snapshot,
      options
    );
  }

  protected isLaunchStateNoopRefreshDue(snapshot: PersistedTeamLaunchSnapshot): boolean {
    return this.launchStateCompatibilityBoundary.isLaunchStateNoopRefreshDue(snapshot);
  }

  protected readPendingOpenCodePrimaryCleanups(
    teamId: string
  ): Promise<PendingOpenCodePrimaryCleanup[]> {
    return this.launchStateCompatibilityBoundary.readPendingOpenCodePrimaryCleanups(teamId);
  }

  protected appendPendingOpenCodePrimaryCleanup(
    cleanup: PendingOpenCodePrimaryCleanup
  ): Promise<void> {
    return this.launchStateCompatibilityBoundary.appendPendingOpenCodePrimaryCleanup(cleanup);
  }

  protected consumePendingOpenCodePrimaryCleanup(
    cleanup: PendingOpenCodePrimaryCleanup
  ): Promise<boolean> {
    return this.launchStateCompatibilityBoundary.consumePendingOpenCodePrimaryCleanup(cleanup);
  }

  protected enqueueLaunchStateStoreOperation<T>(
    teamName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.launchStateCompatibilityBoundary.enqueueLaunchStateStoreOperation(
      teamName,
      operation
    );
  }

  protected getMemberLaunchSummary(run: TRun): PersistedTeamLaunchSummary {
    return this.launchStateCompatibilityBoundary.getMemberLaunchSummary(run);
  }

  protected buildAggregatePendingLaunchMessage(
    prefix: string,
    run: TRun,
    launchSummary: TeamProvisioningLaunchSummaryLike,
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): string {
    return this.launchStateCompatibilityBoundary.buildAggregatePendingLaunchMessage(
      prefix,
      run,
      launchSummary,
      snapshot
    );
  }

  protected buildRuntimeSpawnStatusRecord(run: TRun): Record<string, MemberSpawnStatusEntry> {
    return this.launchStateCompatibilityBoundary.buildRuntimeSpawnStatusRecord(run);
  }

  protected reconcileFinalLaunchReportingSnapshot(
    run: TRun,
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.launchStateCompatibilityBoundary.reconcileFinalLaunchReportingSnapshot(
      run,
      snapshot
    );
  }

  protected syncRunMemberSpawnStatusesFromSnapshot(
    run: TRun,
    snapshot: PersistedTeamLaunchSnapshot
  ): void {
    this.launchStateCompatibilityBoundary.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);
  }

  protected hasPendingLaunchMembers(
    run: TRun,
    launchSummary: { pendingCount: number },
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): boolean {
    return this.launchStateCompatibilityBoundary.hasPendingLaunchMembers(
      run,
      launchSummary,
      snapshot
    );
  }

  protected buildLiveLaunchSnapshotForRun(
    run: TRun,
    launchPhase?: PersistedTeamLaunchPhase
  ): PersistedTeamLaunchSnapshot | null {
    return this.launchStateCompatibilityBoundary.buildLiveLaunchSnapshotForRun(run, launchPhase);
  }

  protected emitMemberSpawnChange(run: Pick<TRun, 'teamName' | 'runId'>, memberName: string): void {
    this.launchStateCompatibilityBoundary.emitMemberSpawnChange(run, memberName);
  }

  protected maybeFireTeamLaunchedNotificationWhenAllMembersJoined(run: TRun): Promise<void> {
    return this.launchStateCompatibilityBoundary.maybeFireTeamLaunchedNotificationWhenAllMembersJoined(
      run
    );
  }

  protected areAllExpectedLaunchMembersConfirmed(run: TRun): boolean {
    return this.launchStateCompatibilityBoundary.areAllExpectedLaunchMembersConfirmed(run);
  }

  protected buildMixedPersistedLaunchSnapshotForRun(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase
  ): PersistedTeamLaunchSnapshot | null {
    return this.launchStateCompatibilityBoundary.buildMixedPersistedLaunchSnapshotForRun(
      run,
      launchPhase
    );
  }

  protected hasMixedLaunchMetadata(snapshot: PersistedTeamLaunchSnapshot | null): boolean {
    return this.launchStateCompatibilityBoundary.hasMixedLaunchMetadata(snapshot);
  }

  protected hasMixedSecondaryLaunchMetadata(snapshot: PersistedTeamLaunchSnapshot | null): boolean {
    return this.launchStateCompatibilityBoundary.hasMixedSecondaryLaunchMetadata(snapshot);
  }

  protected hasPrimaryOnlyLaneAwareLaunchMetadata(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): boolean {
    return this.launchStateCompatibilityBoundary.hasPrimaryOnlyLaneAwareLaunchMetadata(snapshot);
  }

  protected shouldRecoverStalePersistedMixedLaunchSnapshot(
    snapshot: PersistedTeamLaunchSnapshot
  ): boolean {
    return this.launchStateCompatibilityBoundary.shouldRecoverStalePersistedMixedLaunchSnapshot(
      snapshot
    );
  }

  protected persistLaunchStateSnapshot(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase = run.provisioningComplete ? 'finished' : 'active'
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.launchStateCompatibilityBoundary.persistLaunchStateSnapshot(run, launchPhase);
  }

  protected persistLaunchStateSnapshotNow(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.launchStateCompatibilityBoundary.persistLaunchStateSnapshotNow(run, launchPhase);
  }

  protected recoverStaleMixedSecondaryLaunchSnapshot(
    teamName: string,
    bootstrapSnapshot: PersistedTeamLaunchSnapshot | null,
    persistedSnapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.launchStateCompatibilityBoundary.recoverStaleMixedSecondaryLaunchSnapshot(
      teamName,
      bootstrapSnapshot,
      persistedSnapshot
    );
  }

  protected reconcilePersistedLaunchState(
    teamName: string
  ): Promise<PersistedLaunchReconciliationResult> {
    return this.launchStateCompatibilityBoundary.reconcilePersistedLaunchState(teamName);
  }

  protected fireTeamLaunchedNotification(run: TRun): Promise<void> {
    return this.launchStateCompatibilityBoundary.fireTeamLaunchedNotification(run);
  }

  protected fireTeamLaunchIncompleteNotification(
    run: TRun,
    failedMembers: readonly { name: string }[],
    launchSummary: TeamProvisioningLaunchSummaryLike,
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): Promise<void> {
    return this.launchStateCompatibilityBoundary.fireTeamLaunchIncompleteNotification(
      run,
      failedMembers,
      launchSummary,
      snapshot
    );
  }
}
