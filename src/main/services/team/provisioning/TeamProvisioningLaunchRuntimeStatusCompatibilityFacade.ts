import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { readBootstrapLaunchSnapshot } from '../TeamBootstrapStateReader';

import {
  type DeterministicBootstrapCompletionRecoveryServiceHost,
  recoverDeterministicBootstrapCompletionWithService,
} from './TeamProvisioningDeterministicBootstrapCompletionRecovery';
import { TeamProvisioningLaunchStateCompatibilityFacade } from './TeamProvisioningLaunchStateCompatibilityFacade';
import { guardCommittedOpenCodeSecondaryLaneEvidence as guardCommittedOpenCodeSecondaryLaneEvidenceHelper } from './TeamProvisioningLaunchStateReconciliation';
import {
  commitOpenCodeRuntimeAdapterLaunchSessionEvidence,
  launchOpenCodeAggregatePrimaryLane as launchOpenCodeAggregatePrimaryLaneHelper,
  persistOpenCodeRuntimeAdapterLaunchResult,
  summarizeOpenCodeAggregateLaunchState as summarizeOpenCodeAggregateLaunchStateHelper,
} from './TeamProvisioningOpenCodeAggregateLaunchPersistence';
import {
  createTeamProvisioningOpenCodeAggregatePrimaryLanePortsFromService,
  type TeamProvisioningOpenCodeAggregatePrimaryLaneServiceHost,
} from './TeamProvisioningOpenCodeAggregatePrimaryLanePortsFactory';
import { type OpenCodeRuntimeBootstrapEvidencePorts } from './TeamProvisioningOpenCodeBootstrapEvidence';
import {
  createTeamProvisioningOpenCodeLaunchPersistencePortsFromService,
  type TeamProvisioningOpenCodeLaunchPersistenceServiceHost,
} from './TeamProvisioningOpenCodeLaunchPersistencePortsFactory';
import {
  createTeamProvisioningOpenCodeSecondaryLaneEvidencePortsFromService,
  type TeamProvisioningOpenCodeSecondaryLaneEvidenceServiceHost,
} from './TeamProvisioningOpenCodeSecondaryLaneEvidencePortsFactory';
import { isTerminalFailureProvisioningState } from './TeamProvisioningProgressState';
import { extractCliLogsFromRun } from './TeamProvisioningRetainedLogs';
import {
  DETERMINISTIC_BOOTSTRAP_COMPLETION_RECOVERY_MS,
  type ProvisioningRun,
} from './TeamProvisioningRunModel';
import { nowIso, updateProgress } from './TeamProvisioningRunProgress';
import { type TeamProvisioningRunTrackingDeliveryHelper } from './TeamProvisioningRunTrackingDelivery';
import {
  createMixedSecondaryLaneStateForMember as createMixedSecondaryLaneStateForMemberHelper,
  createMixedSecondaryLaneStates as createMixedSecondaryLaneStatesHelper,
  getCurrentOpenCodeRuntimeRunId as resolveOpenCodeRuntimeRunIdFromMaps,
  getMixedSecondaryLaunchPhase as getMixedSecondaryLaunchPhaseHelper,
  type MixedSecondaryRuntimeLaneState,
  removeRunAllEffectiveMember as removeRunAllEffectiveMemberFromRun,
  type RuntimeAdapterRunEntry,
  type SecondaryRuntimeRunEntry,
  upsertRunAllEffectiveMember as upsertRunAllEffectiveMemberInRun,
} from './TeamProvisioningSecondaryRuntimeRuns';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
} from '../runtime';
import type {
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export type TeamProvisioningLaunchRuntimeStatusRunTracking<TRun extends ProvisioningRun> = Pick<
  TeamProvisioningRunTrackingDeliveryHelper<TRun>,
  | 'getTrackedRunId'
  | 'getProvisioningRunId'
  | 'getAliveRunId'
  | 'setAliveRunId'
  | 'getAliveTeamNames'
  | 'canDeliverToOpenCodeRuntimeForTeam'
>;

export abstract class TeamProvisioningLaunchRuntimeStatusCompatibilityFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningLaunchStateCompatibilityFacade<TRun> {
  protected abstract readonly runTracking: TeamProvisioningLaunchRuntimeStatusRunTracking<TRun>;
  protected abstract readonly runtimeSnapshotCacheBoundary: {
    getRuntimeSnapshotCacheGeneration(teamName: string): number;
    invalidateRuntimeSnapshotCaches(teamName: string): void;
  };
  protected abstract readonly runtimeAdapterProgressState: {
    sweepRuntimeAdapterRunState(nowMs?: number): void;
  };
  protected abstract readonly runtimeAdapterProgressByRunId: ReadonlyMap<
    string,
    TeamProvisioningProgress
  >;
  protected abstract readonly provisioningRunByTeam: Map<string, string>;
  protected abstract readonly runtimeAdapterRunByTeam: ReadonlyMap<string, RuntimeAdapterRunEntry>;
  protected abstract readonly secondaryRuntimeRunByTeam: ReadonlyMap<
    string,
    ReadonlyMap<string, SecondaryRuntimeRunEntry>
  >;
  protected abstract readonly cancellationBoundary: {
    isCancellableRuntimeAdapterProgress(progress: TeamProvisioningProgress): boolean;
  };
  protected abstract readonly bootstrapEvidenceFacade: {
    createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts;
  };

  protected invalidateRuntimeSnapshotCaches(teamName: string): void {
    this.runtimeSnapshotCacheBoundary.invalidateRuntimeSnapshotCaches(teamName);
  }

  protected isLaunchRunStillCurrent(run: TRun): boolean {
    return (
      this.runs.get(run.runId) === run &&
      this.runTracking.getProvisioningRunId(run.teamName) === run.runId &&
      !run.cancelRequested &&
      !run.processKilled
    );
  }

  protected createMixedSecondaryLaneStates(
    plan: TeamRuntimeLanePlan
  ): MixedSecondaryRuntimeLaneState[] {
    return createMixedSecondaryLaneStatesHelper(plan);
  }

  protected createMixedSecondaryLaneStateForMember(
    run: Pick<TRun, 'request' | 'mixedSecondaryLanes'>,
    member: TeamCreateRequest['members'][number]
  ): MixedSecondaryRuntimeLaneState {
    return createMixedSecondaryLaneStateForMemberHelper(run, member);
  }

  protected getMixedSecondaryLaunchPhase(run: TRun): PersistedTeamLaunchPhase {
    return getMixedSecondaryLaunchPhaseHelper(run);
  }

  protected upsertRunAllEffectiveMember(
    run: TRun,
    member: TeamCreateRequest['members'][number]
  ): void {
    upsertRunAllEffectiveMemberInRun(run, member);
  }

  protected removeRunAllEffectiveMember(run: TRun, memberName: string): void {
    removeRunAllEffectiveMemberFromRun(run, memberName);
  }

  protected sweepRuntimeAdapterRunState(nowMs: number = Date.now()): void {
    this.runtimeAdapterProgressState.sweepRuntimeAdapterRunState(nowMs);
  }

  protected summarizeOpenCodeAggregateLaunchState(input: {
    primaryResult: TeamRuntimeLaunchResult | null;
    lanes: readonly MixedSecondaryRuntimeLaneState[];
  }): TeamRuntimeLaunchResult['teamLaunchState'] {
    return summarizeOpenCodeAggregateLaunchStateHelper(input);
  }

  protected getCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): string | null {
    return resolveOpenCodeRuntimeRunIdFromMaps({
      teamName,
      laneId,
      trackedRunId: this.runTracking.getTrackedRunId(teamName),
      runs: this.runs,
      provisioningRunByTeam: this.provisioningRunByTeam,
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      secondaryRuntimeRunByTeam: this.secondaryRuntimeRunByTeam,
      shouldRouteOpenCodeToRuntimeAdapter: (request) =>
        this.shouldRouteOpenCodeToRuntimeAdapter(request),
      isCancellableRuntimeAdapterProgress: (progress) =>
        this.cancellationBoundary.isCancellableRuntimeAdapterProgress(progress),
    });
  }

  private createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts {
    return this.bootstrapEvidenceFacade.createOpenCodeRuntimeBootstrapEvidencePorts();
  }

  protected async launchOpenCodeAggregatePrimaryLane(params: {
    run: TRun;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    assertStillCurrentAfterPersistence?: () => void;
  }): Promise<TeamRuntimeLaunchResult | null> {
    return launchOpenCodeAggregatePrimaryLaneHelper(
      params,
      createTeamProvisioningOpenCodeAggregatePrimaryLanePortsFromService(
        this as unknown as TeamProvisioningOpenCodeAggregatePrimaryLaneServiceHost
      )
    );
  }

  private createOpenCodeLaunchPersistencePorts() {
    return createTeamProvisioningOpenCodeLaunchPersistencePortsFromService(
      this as unknown as TeamProvisioningOpenCodeLaunchPersistenceServiceHost,
      { nowIso }
    );
  }

  private async persistOpenCodeRuntimeAdapterLaunchResult(
    result: TeamRuntimeLaunchResult,
    input: TeamRuntimeLaunchInput
  ): Promise<{
    snapshot: PersistedTeamLaunchSnapshot;
    result: TeamRuntimeLaunchResult;
  }> {
    return persistOpenCodeRuntimeAdapterLaunchResult(
      result,
      input,
      this.createOpenCodeLaunchPersistencePorts()
    );
  }

  private async commitOpenCodeRuntimeAdapterLaunchSessionEvidence(params: {
    teamName: string;
    laneId: string;
    result: TeamRuntimeLaunchResult;
  }): Promise<TeamRuntimeLaunchResult> {
    return commitOpenCodeRuntimeAdapterLaunchSessionEvidence(
      params,
      this.createOpenCodeLaunchPersistencePorts()
    );
  }

  protected async guardCommittedOpenCodeSecondaryLaneEvidence(params: {
    teamName: string;
    laneId: string;
    result: TeamRuntimeLaunchResult;
    memberName: string;
  }): Promise<TeamRuntimeLaunchResult> {
    return guardCommittedOpenCodeSecondaryLaneEvidenceHelper(
      params,
      createTeamProvisioningOpenCodeSecondaryLaneEvidencePortsFromService(
        this as unknown as TeamProvisioningOpenCodeSecondaryLaneEvidenceServiceHost,
        {
          logWarn: (message) => logger.warn(message),
        }
      )
    );
  }

  protected isProvisioningRunPromotedToAlive(run: TRun): boolean {
    return (
      this.runTracking.getAliveRunId(run.teamName) === run.runId &&
      this.runTracking.getProvisioningRunId(run.teamName) !== run.runId
    );
  }

  protected hasPendingDeterministicFirstRealTurn(run: TRun): boolean {
    return (
      run.deterministicBootstrap && run.requiresFirstRealTurnSuccess && !run.firstRealTurnSucceeded
    );
  }

  protected isProvisioningRunStillPromotable(run: TRun): boolean {
    if (this.runs.get(run.runId) !== run) return false;
    if (this.runTracking.getProvisioningRunId(run.teamName) !== run.runId) return false;
    if (
      run.cancelRequested ||
      run.processKilled ||
      run.processClosed ||
      run.finalizingByTimeout ||
      run.authRetryInProgress
    ) {
      return false;
    }
    if (
      run.progress.state === 'ready' ||
      run.progress.state === 'disconnected' ||
      run.progress.state === 'cancelled' ||
      isTerminalFailureProvisioningState(run.progress.state)
    ) {
      return false;
    }
    if (!run.child || run.child.killed) return false;
    const stdin = run.child.stdin as
      | (NodeJS.WritableStream & {
          destroyed?: boolean;
          writableEnded?: boolean;
          writable?: boolean;
        })
      | null
      | undefined;
    if (!stdin) return false;
    if (stdin.destroyed || stdin.writableEnded || stdin.writable === false) return false;
    return true;
  }

  protected async publishMixedSecondaryLaneStatusChange(
    run: TRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void> {
    if (!this.isCurrentTrackedRun(run)) {
      return;
    }
    let snapshot: PersistedTeamLaunchSnapshot | null = null;
    if (run.isLaunch) {
      snapshot = await this.persistLaunchStateSnapshot(run, this.getMixedSecondaryLaunchPhase(run));
    }
    if (snapshot) {
      this.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);
    }
    this.emitMemberSpawnChange(run, lane.member.name);
  }

  protected scheduleDeterministicBootstrapCompletionRecovery(run: TRun): void {
    if (!run.deterministicBootstrap) {
      return;
    }

    const handle = setTimeout(() => {
      void this.recoverDeterministicBootstrapCompletion(run).catch((error: unknown) => {
        const errorMessage = getErrorMessage(error);
        logger.warn(
          `[${run.teamName}] Failed to recover completed deterministic bootstrap state: ` +
            errorMessage
        );
      });
    }, DETERMINISTIC_BOOTSTRAP_COMPLETION_RECOVERY_MS);
    handle.unref?.();
  }

  private async recoverDeterministicBootstrapCompletion(run: TRun): Promise<void> {
    await recoverDeterministicBootstrapCompletionWithService<TRun>(
      run,
      this as unknown as DeterministicBootstrapCompletionRecoveryServiceHost<TRun>,
      {
        readBootstrapLaunchSnapshot,
        nowIso,
        getMemberLaunchSummary: (targetRun) => this.getMemberLaunchSummary(targetRun),
        buildAggregatePendingLaunchMessage: (prefix, targetRun, launchSummary, snapshot) =>
          this.buildAggregatePendingLaunchMessage(prefix, targetRun, launchSummary, snapshot),
        updateProgress,
        extractCliLogsFromRun,
        warn: (message) => logger.warn(message),
      }
    );
  }
}
