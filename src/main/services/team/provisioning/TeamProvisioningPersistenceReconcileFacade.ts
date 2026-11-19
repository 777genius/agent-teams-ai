import { captureTeamLaunchPublicationAuthority } from '../TeamLaunchStateStore';

import { getPersistedLaunchMemberNames } from './TeamProvisioningLaunchStateProjection';
import {
  type LaunchStateWriteOptions,
  type LaunchStateWriteResult,
  type TeamProvisioningLaunchStateStoreBoundary,
} from './TeamProvisioningLaunchStateStoreBoundary';
import {
  captureOwnedSoloLaunchSnapshotRun,
  type OwnedSoloLaunchSnapshotRun,
} from './TeamProvisioningLiveLaunchSnapshotBoundaryFactory';
import { filterRemovedMembersFromLaunchSnapshot } from './TeamProvisioningMemberStatusProjection';
import {
  reconcilePersistedLaunchStateWithTeamProvisioningPorts,
  type TeamProvisioningPersistedLaunchReconcilePortsInput,
} from './TeamProvisioningPersistedLaunchReconcilePorts';
import { type PersistedLaunchReconciliationResult } from './TeamProvisioningPersistedLaunchReconciliation';

import type {
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  TeamMember,
} from '@shared/types';

export interface TeamProvisioningPersistenceReconcileRun extends OwnedSoloLaunchSnapshotRun {
  isLaunch: boolean;
}

/**
 * Requests for the same run and phase rebuild the identical snapshot from live state
 * regardless of when they were enqueued, so a pending duplicate is pure waste — collapsing
 * it in `LaunchStateStoreBoundary` cannot change what ends up on disk.
 */
const PERSIST_LAUNCH_SNAPSHOT_COALESCE_KEY_PREFIX = 'persist-launch-snapshot:';

export type TeamProvisioningPersistenceReconcileRuntimePorts = Omit<
  TeamProvisioningPersistedLaunchReconcilePortsInput,
  'readLaunchState' | 'readMembersMeta' | 'writeLaunchStateSnapshot' | 'clearPersistedLaunchState'
>;

export interface TeamProvisioningPersistenceReconcileFacadePorts<
  TRun extends TeamProvisioningPersistenceReconcileRun,
> {
  launchStateStoreBoundary: Pick<
    TeamProvisioningLaunchStateStoreBoundary,
    | 'clearPersistedLaunchState'
    | 'canClearPersistedLaunchStateForRun'
    | 'clearPersistedLaunchStateNow'
    | 'writeLaunchStateSnapshot'
    | 'writeLaunchStateSnapshotNow'
    | 'isLaunchStateNoopRefreshDue'
    | 'enqueue'
  >;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  getRun(runId: string): TRun | undefined;
  readMembersMeta(teamName: string): Promise<readonly TeamMember[]>;
  overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(run: TRun): Promise<void>;
  buildLiveLaunchSnapshotForRun(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase
  ): PersistedTeamLaunchSnapshot | null;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  reconcile: TeamProvisioningPersistenceReconcileRuntimePorts;
  runPersistedLaunchReconcile?(
    teamName: string,
    input: TeamProvisioningPersistedLaunchReconcilePortsInput
  ): Promise<PersistedLaunchReconciliationResult>;
}

export interface TeamProvisioningPersistenceReconcileFacadeServiceHost<
  TRun extends TeamProvisioningPersistenceReconcileRun,
> extends TeamProvisioningPersistenceReconcileRuntimePorts {
  runs: ReadonlyMap<string, TRun>;
  launchStateStore: {
    read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  };
  membersMetaStore: {
    getMembers(teamName: string): Promise<readonly TeamMember[]>;
  };
  launchStateStoreBoundary: TeamProvisioningPersistenceReconcileFacadePorts<TRun>['launchStateStoreBoundary'];
  primaryBootstrapTruthReporting: {
    overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(run: TRun): Promise<void>;
  };
  buildLiveLaunchSnapshotForRun(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase
  ): PersistedTeamLaunchSnapshot | null;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  getTrackedRunId(teamName: string): string | null | undefined;
}

export class TeamProvisioningPersistenceReconcileFacade<
  TRun extends TeamProvisioningPersistenceReconcileRun,
> {
  constructor(private readonly ports: TeamProvisioningPersistenceReconcileFacadePorts<TRun>) {}

  async clearPersistedLaunchState(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void> {
    await this.ports.launchStateStoreBoundary.clearPersistedLaunchState(teamName, options);
  }

  canClearPersistedLaunchStateForRun(teamName: string, expectedRunId: string | undefined): boolean {
    return this.ports.launchStateStoreBoundary.canClearPersistedLaunchStateForRun(
      teamName,
      expectedRunId
    );
  }

  async clearPersistedLaunchStateNow(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void> {
    await this.ports.launchStateStoreBoundary.clearPersistedLaunchStateNow(teamName, options);
  }

  async writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: LaunchStateWriteOptions
  ): Promise<PersistedTeamLaunchSnapshot> {
    return options === undefined
      ? this.ports.launchStateStoreBoundary.writeLaunchStateSnapshot(teamName, snapshot)
      : this.ports.launchStateStoreBoundary.writeLaunchStateSnapshot(teamName, snapshot, options);
  }

  async writeLaunchStateSnapshotNow(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: LaunchStateWriteOptions
  ): Promise<LaunchStateWriteResult> {
    return this.ports.launchStateStoreBoundary.writeLaunchStateSnapshotNow(
      teamName,
      snapshot,
      options
    );
  }

  isLaunchStateNoopRefreshDue(snapshot: PersistedTeamLaunchSnapshot): boolean {
    return this.ports.launchStateStoreBoundary.isLaunchStateNoopRefreshDue(snapshot);
  }

  enqueueLaunchStateStoreOperation<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    return this.ports.launchStateStoreBoundary.enqueue(teamName, operation);
  }

  async persistLaunchStateSnapshot(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase = run.provisioningComplete ? 'finished' : 'active'
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    const ownedSoloIsCurrent =
      launchPhase === 'finished' ? this.captureOwnedSoloPublication(run) : null;
    if (ownedSoloIsCurrent) {
      // This branch captures the original child/session and publication epoch before queueing.
      // It cannot share the fresh-state-only coalescing used by ordinary member snapshots.
      return this.ports.launchStateStoreBoundary.enqueue(run.teamName, () =>
        this.persistLaunchStateSnapshotNow(run, launchPhase, ownedSoloIsCurrent)
      );
    }
    // The operation below captures nothing besides (run, launchPhase) — everything else is
    // read fresh from live state when it executes — so a request that arrives before the
    // queued entry starts is fully covered by it. If a future change captures more at
    // enqueue time (e.g. publication authority), fold it into the key or stop coalescing.
    return this.ports.launchStateStoreBoundary.enqueue(
      run.teamName,
      () => this.persistLaunchStateSnapshotNow(run, launchPhase, null),
      {
        coalesce: {
          subject: run,
          key: `${PERSIST_LAUNCH_SNAPSHOT_COALESCE_KEY_PREFIX}${launchPhase}`,
        },
      }
    );
  }

  async persistLaunchStateSnapshotNow(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase,
    ownedSoloIsCurrent: (() => boolean) | null = launchPhase === 'finished'
      ? this.captureOwnedSoloPublication(run)
      : null
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    if (ownedSoloIsCurrent && !ownedSoloIsCurrent()) return null;
    await this.ports.overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(run);
    if (ownedSoloIsCurrent && !ownedSoloIsCurrent()) return null;
    if (!ownedSoloIsCurrent && captureOwnedSoloLaunchSnapshotRun(run)) return null;
    const snapshot = this.ports.buildLiveLaunchSnapshotForRun(run, launchPhase);
    if (!snapshot) {
      if (run.isLaunch) {
        await this.clearPersistedLaunchStateNow(run.teamName, { expectedRunId: run.runId });
      }
      return null;
    }

    const metaMembers = await this.ports
      .readMembersMeta(run.teamName)
      .catch(() => (ownedSoloIsCurrent ? null : []));
    if (metaMembers === null) return null;
    if (ownedSoloIsCurrent && (!ownedSoloIsCurrent() || metaMembers.length !== 0)) return null;
    const filteredSnapshot = filterRemovedMembersFromLaunchSnapshot(
      snapshot,
      metaMembers,
      getPersistedLaunchMemberNames(snapshot)
    );

    if (
      filteredSnapshot.teamLaunchState === 'clean_success' &&
      launchPhase !== 'active' &&
      !ownedSoloIsCurrent
    ) {
      await this.clearPersistedLaunchStateNow(run.teamName, { expectedRunId: run.runId });
      // Disk cleanup must not discard the current evidence needed by live run/status consumers.
      return filteredSnapshot;
    }

    const writeResult = await this.writeLaunchStateSnapshotNow(run.teamName, filteredSnapshot, {
      allowNoopSkip: true,
      runId: run.runId,
      metaMembers,
      ...(ownedSoloIsCurrent
        ? {
            ownedSoloLaunch: true,
            requireTrackedRun: true,
            isAuthorized: ownedSoloIsCurrent,
          }
        : {}),
    });
    if (writeResult.wrote) {
      this.ports.invalidateRuntimeSnapshotCaches(run.teamName);
    }
    if (ownedSoloIsCurrent && !ownedSoloIsCurrent()) return null;
    return writeResult.snapshot;
  }

  private captureOwnedSoloPublication(run: TRun): (() => boolean) | null {
    const ownerIsCurrent = captureOwnedSoloLaunchSnapshotRun(run);
    if (!ownerIsCurrent) return null;
    const { teamName, runId } = run;
    const publicationIsCurrent = captureTeamLaunchPublicationAuthority(teamName);
    const current = (): boolean =>
      ownerIsCurrent() &&
      publicationIsCurrent() &&
      this.ports.getRun(runId) === run &&
      this.ports.reconcile.getTrackedRunId?.(teamName) === runId;
    return current;
  }

  async reconcilePersistedLaunchState(
    teamName: string
  ): Promise<PersistedLaunchReconciliationResult> {
    const runReconcile =
      this.ports.runPersistedLaunchReconcile ??
      reconcilePersistedLaunchStateWithTeamProvisioningPorts;
    return runReconcile(teamName, {
      ...this.ports.reconcile,
      readLaunchState: (targetTeamName) => this.ports.readLaunchState(targetTeamName),
      readMembersMeta: (targetTeamName) => this.ports.readMembersMeta(targetTeamName),
      writeLaunchStateSnapshot: (targetTeamName, snapshot, options) =>
        this.writeLaunchStateSnapshot(targetTeamName, snapshot, options),
      clearPersistedLaunchState: (targetTeamName, options) =>
        this.clearPersistedLaunchState(targetTeamName, options),
    });
  }
}

export function createTeamProvisioningPersistenceReconcileFacadeFromService<
  TRun extends TeamProvisioningPersistenceReconcileRun,
>(
  service: TeamProvisioningPersistenceReconcileFacadeServiceHost<TRun>
): TeamProvisioningPersistenceReconcileFacade<TRun> {
  return new TeamProvisioningPersistenceReconcileFacade<TRun>({
    launchStateStoreBoundary: service.launchStateStoreBoundary,
    readLaunchState: (teamName) => service.launchStateStore.read(teamName),
    getRun: (runId) => service.runs.get(runId),
    readMembersMeta: (teamName) => service.membersMetaStore.getMembers(teamName),
    overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState: (run) =>
      service.primaryBootstrapTruthReporting.overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(
        run
      ),
    buildLiveLaunchSnapshotForRun: (run, launchPhase) =>
      service.buildLiveLaunchSnapshotForRun(run, launchPhase),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      service.invalidateRuntimeSnapshotCaches(teamName),
    reconcile: {
      getTrackedRunId: (teamName) => service.getTrackedRunId(teamName),
      recoverStaleMixedSecondaryLaunchSnapshot: (teamName, bootstrapSnapshot, persistedSnapshot) =>
        service.recoverStaleMixedSecondaryLaunchSnapshot(
          teamName,
          bootstrapSnapshot,
          persistedSnapshot
        ),
      applyOpenCodeSecondaryEvidenceOverlay: (input) =>
        service.applyOpenCodeSecondaryEvidenceOverlay(input),
      applyOpenCodeSecondaryBootstrapStallOverlay: (snapshot) =>
        service.applyOpenCodeSecondaryBootstrapStallOverlay(snapshot),
      getLiveTeamAgentRuntimeMetadata: (teamName) =>
        service.getLiveTeamAgentRuntimeMetadata(teamName),
      readPersistedRuntimeMembers: (teamName) => service.readPersistedRuntimeMembers(teamName),
      resolveExpectedLaunchMemberName: (members, candidateName) =>
        service.resolveExpectedLaunchMemberName(members, candidateName),
      findBootstrapRuntimeProofObservedAt: (teamName, memberName, member) =>
        service.findBootstrapRuntimeProofObservedAt(teamName, memberName, member),
      findBootstrapTranscriptOutcome: (teamName, memberName, sinceMs) =>
        service.findBootstrapTranscriptOutcome(teamName, memberName, sinceMs),
    },
  });
}
