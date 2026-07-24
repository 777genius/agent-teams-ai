import { getPersistedLaunchMemberNames } from './TeamProvisioningLaunchStateProjection';
import {
  type LaunchStateWriteOptions,
  type LaunchStateWriteResult,
  type PendingOpenCodePrimaryCleanup,
  type TeamProvisioningLaunchStateStoreBoundary,
} from './TeamProvisioningLaunchStateStoreBoundary';
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

export interface TeamProvisioningPersistenceReconcileRun {
  teamName: string;
  runId: string;
  isLaunch: boolean;
  provisioningComplete: boolean;
}

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
  > &
    Partial<
      Pick<
        TeamProvisioningLaunchStateStoreBoundary,
        | 'readPendingOpenCodePrimaryCleanups'
        | 'appendPendingOpenCodePrimaryCleanup'
        | 'consumePendingOpenCodePrimaryCleanup'
      >
    >;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
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

  readPendingOpenCodePrimaryCleanups(teamId: string): Promise<PendingOpenCodePrimaryCleanup[]> {
    const read = this.ports.launchStateStoreBoundary.readPendingOpenCodePrimaryCleanups;
    if (!read) {
      throw new Error('OpenCode primary cleanup outbox is unavailable');
    }
    return read.call(this.ports.launchStateStoreBoundary, teamId);
  }

  appendPendingOpenCodePrimaryCleanup(cleanup: PendingOpenCodePrimaryCleanup): Promise<void> {
    const append = this.ports.launchStateStoreBoundary.appendPendingOpenCodePrimaryCleanup;
    if (!append) {
      throw new Error('OpenCode primary cleanup outbox is unavailable');
    }
    return append.call(this.ports.launchStateStoreBoundary, cleanup);
  }

  consumePendingOpenCodePrimaryCleanup(cleanup: PendingOpenCodePrimaryCleanup): Promise<boolean> {
    const consume = this.ports.launchStateStoreBoundary.consumePendingOpenCodePrimaryCleanup;
    if (!consume) {
      throw new Error('OpenCode primary cleanup outbox is unavailable');
    }
    return consume.call(this.ports.launchStateStoreBoundary, cleanup);
  }

  enqueueLaunchStateStoreOperation<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    return this.ports.launchStateStoreBoundary.enqueue(teamName, operation);
  }

  async persistLaunchStateSnapshot(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase = run.provisioningComplete ? 'finished' : 'active'
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.enqueueLaunchStateStoreOperation(run.teamName, () =>
      this.persistLaunchStateSnapshotNow(run, launchPhase)
    );
  }

  async persistLaunchStateSnapshotNow(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    await this.ports.overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(run);
    const snapshot = this.ports.buildLiveLaunchSnapshotForRun(run, launchPhase);
    if (!snapshot) {
      if (run.isLaunch) {
        await this.clearPersistedLaunchStateNow(run.teamName, { expectedRunId: run.runId });
      }
      return null;
    }

    const metaMembers = await this.ports.readMembersMeta(run.teamName).catch(() => []);
    const filteredSnapshot = filterRemovedMembersFromLaunchSnapshot(
      snapshot,
      metaMembers,
      getPersistedLaunchMemberNames(snapshot)
    );

    if (filteredSnapshot.teamLaunchState === 'clean_success' && launchPhase !== 'active') {
      await this.clearPersistedLaunchStateNow(run.teamName, { expectedRunId: run.runId });
      return null;
    }

    const writeResult = await this.writeLaunchStateSnapshotNow(run.teamName, filteredSnapshot, {
      allowNoopSkip: true,
      runId: run.runId,
    });
    if (writeResult.wrote) {
      this.ports.invalidateRuntimeSnapshotCaches(run.teamName);
    }
    return writeResult.snapshot;
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
      writeLaunchStateSnapshot: (targetTeamName, snapshot) =>
        this.writeLaunchStateSnapshot(targetTeamName, snapshot),
      clearPersistedLaunchState: (targetTeamName) => this.clearPersistedLaunchState(targetTeamName),
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
