import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { OpenCodeAggregatePrimaryProgressPublisher } from './OpenCodeAggregatePrimaryProgressPublisher';
import {
  beginAggregatePrimaryRestart,
  clearPersistedAggregateLaunchStateIfOwned,
  getCancelledAggregateRestartError,
  resolveAggregatePrimaryRestartCandidate,
  waitForAggregateMemberLifecycleOperations,
  waitForAggregatePrimaryRestart,
} from './OpenCodeAggregatePrimaryRestartPolicy';
import { type TeamProvisioningMemberLifecycleController } from './TeamProvisioningMemberLifecycle';
import {
  type LiveRosterAttachReason,
  type ProvisioningRun as MemberLifecycleProvisioningRun,
} from './TeamProvisioningMemberLifecycleTypes';
import { OpenCodeAggregateRuntimeStopError } from './TeamProvisioningOpenCodeAggregateLaunchPersistence';
import {
  retryPendingOpenCodePrimaryCleanup as retryPendingOpenCodePrimaryCleanupWithPorts,
  stopFailedOpenCodeAggregatePrimaryRelaunchCandidate as stopFailedOpenCodeAggregatePrimaryRelaunchCandidateWithPorts,
  type StopFailedOpenCodeAggregatePrimaryRelaunchCandidateInput,
  stopUnretainableOpenCodePrimaryLane as stopUnretainableOpenCodePrimaryLaneWithPorts,
  type StopUnretainableOpenCodePrimaryLaneInput,
  type TeamProvisioningOpenCodeAggregatePrimaryCleanupPorts,
} from './TeamProvisioningOpenCodeAggregatePrimaryCleanup';
import {
  restartPureOpenCodeAggregatePrimaryMember,
  type TeamProvisioningOpenCodeAggregatePrimaryMemberRestartPorts,
} from './TeamProvisioningOpenCodeAggregatePrimaryMemberRestart';
import {
  getOpenCodeAggregatePrimaryDeliveryRejection,
  isOpenCodeAggregateTeamAlive,
} from './TeamProvisioningOpenCodeAggregatePrimaryRuntimeState';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { nowIso } from './TeamProvisioningRunProgress';
import { TeamProvisioningServiceMemberLifecycleFacade } from './TeamProvisioningServiceMemberLifecycleFacade';
import {
  type OpenCodeAggregatePrimaryRestartLease,
  type PrimaryRuntimeLaunchIntent,
  type PrimaryRuntimeStoppingState,
} from './TeamProvisioningServiceRuntimeStateFacade';

import type {
  OpenCodeMemberInboxDelivery,
  OpenCodeMemberMessageDeliveryInput,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { OpenCodeTeamRuntimeMessageResult } from '../runtime';
import type {
  RetryFailedOpenCodeSecondaryLanesResult,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

/** Owns serialized lifecycle and aggregate-primary restart orchestration. */
export abstract class TeamProvisioningOpenCodeAggregatePrimaryFacade extends TeamProvisioningServiceMemberLifecycleFacade {
  private readonly aggregatePrimaryProgress = new OpenCodeAggregatePrimaryProgressPublisher({
    usesRetainedProgressState: () =>
      Boolean(this.compatibilityDelegation?.retainedProvisioningProgressState),
    setRuntimeAdapterProgress: (progress, onProgress) =>
      this.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress, onProgress),
    enrichRuntimeAdapterProgressTrace: (progress) =>
      this.runtimeAdapterProgressState.enrichRuntimeAdapterProgressTrace(progress),
    rememberProgress: (progress) =>
      this.runtimeAdapterProgressByRunId.set(progress.runId, progress),
    invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
  });
  private readonly aggregatePrimaryCleanupPorts: TeamProvisioningOpenCodeAggregatePrimaryCleanupPorts =
    {
      progress: this.aggregatePrimaryProgress,
      getOpenCodeRuntimeLaunchCwd: (baseCwd, members) =>
        this.prepareFacade.getOpenCodeRuntimeLaunchCwd(baseCwd, members),
      getRuntimeOwner: (teamName) => this.runtimeAdapterRunByTeam.get(teamName),
      setRuntimeOwner: (teamName, owner) => this.runtimeAdapterRunByTeam.set(teamName, owner),
      deleteRuntimeOwner: (teamName) => this.runtimeAdapterRunByTeam.delete(teamName),
      appendPendingCleanup: (cleanup) => this.appendPendingOpenCodePrimaryCleanup(cleanup),
      readPendingCleanups: (teamName) => this.readPendingOpenCodePrimaryCleanups(teamName),
      consumePendingCleanup: async (cleanup) => {
        await this.consumePendingOpenCodePrimaryCleanup(cleanup);
      },
      clearPrimaryLaneIfOwned: (teamName, runId) =>
        this.cancellationBoundary.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId),
      getOpenCodeRuntimeAdapter: () => this.appShellBoundary.getOpenCodeRuntimeAdapter(),
    };
  private readonly aggregatePrimaryMemberRestartPorts: TeamProvisioningOpenCodeAggregatePrimaryMemberRestartPorts =
    {
      restartMember: (teamName, memberName) =>
        this.memberLifecycleController.restartMember(teamName, memberName),
      getOpenCodeRuntimeAdapter: () => this.appShellBoundary.getOpenCodeRuntimeAdapter(),
      isRunCurrent: (run) => this.runs.get(run.runId) === run,
      clearCancelledRestartState: (teamName, runId) =>
        this.clearCancelledOpenCodeAggregateRestartState(teamName, runId),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      getRunLeadName: (run) => this.getRunLeadName(run),
      getRuntimeOwner: (teamName) => this.runtimeAdapterRunByTeam.get(teamName),
      stopRuntimeAdapterTeam: (teamName, runId) =>
        this.stopOpenCodeRuntimeAdapterTeam(teamName, runId),
      setAliveRunId: (teamName, runId) => this.runTracking.setAliveRunId(teamName, runId),
      deleteAliveRunId: (teamName) => this.runTracking.deleteAliveRunId(teamName),
      persistRestartSystemMessage: (input) =>
        this.memberLifecycleUseCases.persistOpenCodeMemberRestartSystemMessage(input),
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      resetRuntimeToolActivity: (run, memberName) => this.resetRuntimeToolActivity(run, memberName),
      clearMemberSpawnToolTracking: (run, memberName) =>
        this.clearMemberSpawnToolTracking(run, memberName),
      launchPrimaryLane: (input) => this.launchOpenCodeAggregatePrimaryLane(input),
      stopUnretainablePrimaryLane: (input) => this.stopUnretainableOpenCodePrimaryLane(input),
      clearPrimaryStopAfterRelaunch: (teamName, runId) =>
        this.clearPrimaryRuntimeStopAfterMatchingRelaunch(teamName, runId),
      stopFailedRelaunchCandidate: (input) =>
        this.stopFailedOpenCodeAggregatePrimaryRelaunchCandidate(input),
      persistLaunchStateSnapshot: (run, phase) => this.persistLaunchStateSnapshot(run, phase),
      getMixedSecondaryLaunchPhase: (run) => this.getMixedSecondaryLaunchPhase(run),
      setRuntimeAdapterProgress: (progress, onProgress) =>
        this.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress, onProgress),
      stopMixedSecondaryRuntimeLanes: (teamName) => this.stopMixedSecondaryRuntimeLanes(teamName),
      clearPersistedLaunchState: (teamName, options) =>
        this.clearPersistedLaunchState(teamName, options),
      clearPrimaryLaneIfOwned: (teamName, runId) =>
        this.cancellationBoundary.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId),
      getRun: (runId) => this.runs.get(runId),
      cleanupRun: (run) => this.cleanupRun(run),
      launchSingleMixedSecondaryLane: (run, lane) => this.launchSingleMixedSecondaryLane(run, lane),
      isTeamAlive: (teamName) => this.isTeamAlive(teamName),
    };
  private runAfterInFlightTeamOperation<T>(
    teamName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.isLiveRosterMutationLockHeld(teamName)) {
      return operation();
    }
    const pendingTeamOperation = this.teamOpLocks.get(teamName);
    return pendingTeamOperation ? pendingTeamOperation.then(operation) : operation();
  }
  private beginPrimaryRuntimeStop(
    teamName: string,
    runId: string,
    kind: PrimaryRuntimeStoppingState['kind'],
    intentGeneration?: number
  ): PrimaryRuntimeStoppingState {
    const current = this.stoppingPrimaryRuntimeTeams.get(teamName);
    const generation =
      intentGeneration ?? current?.intentGeneration ?? this.nextPrimaryRuntimeIntentGeneration();
    if (current && current.intentGeneration > generation) {
      return current;
    }
    if (
      kind === 'replacement' &&
      current?.kind === 'manual' &&
      current.intentGeneration === generation
    ) {
      return current;
    }
    if (
      current?.kind === kind &&
      current.runId === runId &&
      current.intentGeneration === generation
    ) {
      return current;
    }

    const state: PrimaryRuntimeStoppingState = {
      kind,
      runId,
      stopConfirmed: false,
      intentGeneration: generation,
    };
    this.stoppingPrimaryRuntimeTeams.set(teamName, state);
    return state;
  }
  protected async waitForMemberLifecycleOperations(teamName: string): Promise<void> {
    await waitForAggregateMemberLifecycleOperations({
      teamName,
      memberLifecycleCompletions: this.memberLifecycleCompletionByKey.values(),
      failedLaneRetries: this.failedOpenCodeSecondaryRetryInFlightByTeam.entries(),
    });
  }
  protected collectFailedOpenCodeSecondaryRetryCandidates(
    run: MemberLifecycleProvisioningRun
  ): ReturnType<
    TeamProvisioningMemberLifecycleController['collectFailedOpenCodeSecondaryRetryCandidatesInternal']
  > {
    return this.memberLifecycleController.collectFailedOpenCodeSecondaryRetryCandidatesInternal(
      run
    );
  }
  private beginOpenCodeAggregatePrimaryRestart(
    teamName: string,
    memberName: string,
    runId: string
  ): { lease: OpenCodeAggregatePrimaryRestartLease; release: () => void } {
    return beginAggregatePrimaryRestart({
      teamName,
      memberName,
      runId,
      restarts: this.openCodeAggregatePrimaryRestartByTeam,
      memberLifecycleCompletions: this.memberLifecycleCompletionByKey,
    });
  }
  private isOpenCodeAggregatePrimaryRestartCandidate(
    teamName: string,
    memberName: string
  ): { runId: string; run: ProvisioningRun | null } | null {
    const runtimeRun = this.runtimeAdapterRunByTeam.get(teamName);
    const aliveRunId = this.runTracking.getAliveRunId(teamName);
    const run = aliveRunId ? (this.runs.get(aliveRunId) ?? null) : null;
    return resolveAggregatePrimaryRestartCandidate({ runtimeRun, run, memberName });
  }
  protected async waitForOpenCodeAggregatePrimaryRestart(
    teamName: string,
    currentMemberName?: string
  ): Promise<string | null> {
    return waitForAggregatePrimaryRestart({
      teamName,
      currentMemberName,
      restarts: this.openCodeAggregatePrimaryRestartByTeam,
    });
  }
  private async clearCancelledOpenCodeAggregateRestartState(
    teamName: string,
    runId: string,
    confirmedCancelledRestart?: OpenCodeAggregatePrimaryRestartLease
  ): Promise<void> {
    await this.clearPersistedOpenCodeLaunchStateIfOwned(
      teamName,
      runId,
      confirmedCancelledRestart
    ).catch((error: unknown) => {
      logger.warn(
        `[${teamName}] Failed to clear late launch state after cancelled primary restart: ${getErrorMessage(error)}`
      );
    });
    await this.cancellationBoundary.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId);
  }
  private async clearPersistedOpenCodeLaunchStateIfOwned(
    teamName: string,
    expectedRunId: string,
    confirmedCancelledRestart?: OpenCodeAggregatePrimaryRestartLease
  ): Promise<void> {
    await clearPersistedAggregateLaunchStateIfOwned({
      teamName,
      expectedRunId,
      confirmedCancelledRestart,
      getTrackedRunId: (candidateTeamName) => this.runTracking.getTrackedRunId(candidateTeamName),
      lastWrittenRunIds: this.launchStateWrittenRunIdByTeam,
      restarts: this.openCodeAggregatePrimaryRestartByTeam,
      launchStateStore: this.launchStateStore,
      withLaunchStateLock: (operation) =>
        this.enqueueLaunchStateStoreOperation(teamName, operation),
      invalidateRuntimeSnapshotCaches: (candidateTeamName) =>
        this.invalidateRuntimeSnapshotCaches(candidateTeamName),
    });
  }
  private restartPureOpenCodeAggregatePrimaryMemberExclusive(params: {
    teamName: string;
    memberName: string;
    run: ProvisioningRun;
    restartLease: OpenCodeAggregatePrimaryRestartLease;
  }): Promise<void> {
    return restartPureOpenCodeAggregatePrimaryMember(
      params,
      this.aggregatePrimaryMemberRestartPorts
    );
  }
  private stopUnretainableOpenCodePrimaryLane(
    input: StopUnretainableOpenCodePrimaryLaneInput
  ): Promise<void> {
    return stopUnretainableOpenCodePrimaryLaneWithPorts(input, this.aggregatePrimaryCleanupPorts);
  }

  protected retryPendingOpenCodePrimaryCleanup(teamName: string): Promise<void> {
    return retryPendingOpenCodePrimaryCleanupWithPorts(teamName, this.aggregatePrimaryCleanupPorts);
  }

  private stopFailedOpenCodeAggregatePrimaryRelaunchCandidate(
    input: StopFailedOpenCodeAggregatePrimaryRelaunchCandidateInput
  ): Promise<void> {
    return stopFailedOpenCodeAggregatePrimaryRelaunchCandidateWithPorts(
      input,
      this.aggregatePrimaryCleanupPorts
    );
  }
  override async attachLiveRosterMember(
    teamName: string,
    memberName: string,
    options?: { reason?: LiveRosterAttachReason }
  ): Promise<void> {
    return this.runAfterInFlightTeamOperation(teamName, () =>
      this.memberLifecycleController.attachLiveRosterMember(teamName, memberName, options)
    );
  }

  override async detachLiveRosterMember(teamName: string, memberName: string): Promise<void> {
    return this.runAfterInFlightTeamOperation(teamName, () =>
      this.memberLifecycleController.detachLiveRosterMember(teamName, memberName)
    );
  }

  override async restartMember(teamName: string, memberName: string): Promise<void> {
    return this.runAfterInFlightTeamOperation(teamName, async () => {
      await this.retryPendingOpenCodePrimaryCleanup(teamName);
      const activeRestart = this.openCodeAggregatePrimaryRestartByTeam.get(
        teamName.trim().toLowerCase()
      );
      if (activeRestart) {
        throw new Error(
          `OpenCode aggregate primary restart for teammate "${activeRestart.memberName}" is already in progress for team "${teamName}"`
        );
      }
      const candidate = this.isOpenCodeAggregatePrimaryRestartCandidate(teamName, memberName);
      if (!candidate) {
        return this.memberLifecycleController.restartMember(teamName, memberName);
      }

      const restart = this.beginOpenCodeAggregatePrimaryRestart(
        teamName,
        memberName,
        candidate.runId
      );
      try {
        await Promise.all(restart.lease.precedingLifecycleOperations);
        if (candidate.run) {
          await this.memberLifecycleOperationUseCases.runMemberLifecycleOperation(
            teamName,
            memberName,
            'manual_restart',
            () =>
              this.restartPureOpenCodeAggregatePrimaryMemberExclusive({
                teamName,
                memberName,
                run: candidate.run!,
                restartLease: restart.lease,
              })
          );
        } else {
          await this.memberLifecycleController.restartMember(teamName, memberName);
        }
        if (restart.lease.cancelRequested) {
          await this.clearCancelledOpenCodeAggregateRestartState(teamName, restart.lease.runId);
          throw getCancelledAggregateRestartError(teamName, memberName);
        }
      } catch (error) {
        if (restart.lease.cancelRequested) {
          const cleanupUnconfirmed = error instanceof OpenCodeAggregateRuntimeStopError;
          if (!cleanupUnconfirmed) {
            await this.clearCancelledOpenCodeAggregateRestartState(teamName, restart.lease.runId);
          }
          if (
            cleanupUnconfirmed ||
            getErrorMessage(error).includes('owning run is no longer active')
          ) {
            throw error;
          }
          throw getCancelledAggregateRestartError(teamName, memberName);
        }
        throw error;
      } finally {
        restart.release();
      }
    });
  }

  protected override async reconcilePersistedLaunchState(teamName: string) {
    await this.retryPendingOpenCodePrimaryCleanup(teamName);
    return super.reconcilePersistedLaunchState(teamName);
  }

  override async retryFailedOpenCodeSecondaryLanes(
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult> {
    return this.runAfterInFlightTeamOperation(teamName, () =>
      this.memberLifecycleController.retryFailedOpenCodeSecondaryLanes(teamName)
    );
  }

  override async reattachOpenCodeOwnedMemberLane(
    teamName: string,
    memberName: string,
    options?: { reason?: 'member_added' | 'member_updated' | 'manual_restart' }
  ): Promise<void> {
    return this.runAfterInFlightTeamOperation(teamName, () =>
      this.memberLifecycleController.reattachOpenCodeOwnedMemberLane(teamName, memberName, options)
    );
  }

  override async detachOpenCodeOwnedMemberLane(
    teamName: string,
    memberName: string
  ): Promise<void> {
    return this.runAfterInFlightTeamOperation(teamName, () =>
      this.memberLifecycleController.detachOpenCodeOwnedMemberLane(teamName, memberName)
    );
  }

  private nextPrimaryRuntimeIntentGeneration(): number {
    this.primaryRuntimeIntentGeneration += 1;
    return this.primaryRuntimeIntentGeneration;
  }

  private recordPrimaryRuntimeRelaunchIntent(teamName: string, generation: number): void {
    const current = this.stoppingPrimaryRuntimeTeams.get(teamName);
    if (!current || current.intentGeneration >= generation) {
      return;
    }
    this.stoppingPrimaryRuntimeTeams.set(teamName, {
      ...current,
      kind: 'replacement',
      intentGeneration: generation,
    });
  }

  private rollbackUncommittedPrimaryRuntimeRelaunchIntent(
    intent: PrimaryRuntimeLaunchIntent
  ): void {
    if (
      !intent.admissionCommitted ||
      intent.stopStarted ||
      intent.previousStoppingState === intent.replacementStoppingState ||
      this.stoppingPrimaryRuntimeTeams.get(intent.teamName) !== intent.replacementStoppingState
    ) {
      return;
    }
    if (intent.previousStoppingState) {
      this.stoppingPrimaryRuntimeTeams.set(intent.teamName, intent.previousStoppingState);
    } else {
      this.stoppingPrimaryRuntimeTeams.delete(intent.teamName);
    }
  }

  protected override async withTeamLock<T>(teamName: string, fn: () => Promise<T>): Promise<T> {
    const launchIntent = this.primaryRuntimeLaunchIntent.getStore();
    return await super.withTeamLock(teamName, async () => {
      if (launchIntent?.teamName === teamName && !launchIntent.admissionCommitted) {
        launchIntent.admissionCommitted = true;
        launchIntent.previousStoppingState = this.stoppingPrimaryRuntimeTeams.get(teamName);
        this.recordPrimaryRuntimeRelaunchIntent(teamName, launchIntent.generation);
        launchIntent.replacementStoppingState = this.stoppingPrimaryRuntimeTeams.get(teamName);
      }
      return await fn();
    });
  }

  private clearPrimaryRuntimeStopAfterMatchingRelaunch(
    teamName: string,
    responseRunId: string,
    intentGeneration?: number
  ): void {
    const state = this.stoppingPrimaryRuntimeTeams.get(teamName);
    const runtimeRun = this.runtimeAdapterRunByTeam.get(teamName);
    if (
      state?.kind === 'replacement' &&
      state.stopConfirmed &&
      (intentGeneration === undefined || state.intentGeneration === intentGeneration) &&
      runtimeRun?.providerId === 'opencode' &&
      runtimeRun.runId === responseRunId
    ) {
      this.stoppingPrimaryRuntimeTeams.delete(teamName);
    }
  }

  override stopTeam(teamName: string): Promise<void> {
    const teamKey = teamName.trim().toLowerCase();
    const existingStop = this.teamStopInFlightByTeam.get(teamKey);
    if (existingStop) {
      return existingStop;
    }
    const promise = this.stopTeamWithGuards(teamName).finally(() => {
      if (this.teamStopInFlightByTeam.get(teamKey) === promise) {
        this.teamStopInFlightByTeam.delete(teamKey);
      }
    });
    this.teamStopInFlightByTeam.set(teamKey, promise);
    return promise;
  }

  private async stopTeamWithGuards(teamName: string): Promise<void> {
    const teamKey = teamName.trim().toLowerCase();
    const aggregateRestart = this.openCodeAggregatePrimaryRestartByTeam.get(teamKey);
    if (aggregateRestart) {
      aggregateRestart.cancelRequested = true;
    }
    const primaryStopInFlight = this.openCodeRuntimeAdapterStopInFlightByTeam.get(teamKey)?.promise;
    const intentGeneration = this.nextPrimaryRuntimeIntentGeneration();
    const runtimeRun = this.runtimeAdapterRunByTeam.get(teamName);
    const stoppingState = this.stoppingPrimaryRuntimeTeams.get(teamName);
    if (runtimeRun?.providerId !== 'opencode' && !stoppingState) {
      try {
        await super.stopTeam(teamName);
      } finally {
        await primaryStopInFlight;
      }
      return;
    }

    const manualStop = this.beginPrimaryRuntimeStop(
      teamName,
      runtimeRun?.providerId === 'opencode' ? runtimeRun.runId : stoppingState!.runId,
      'manual',
      intentGeneration
    );
    try {
      await super.stopTeam(teamName);
    } finally {
      await primaryStopInFlight;
    }
    const currentStoppingState = this.stoppingPrimaryRuntimeTeams.get(teamName);
    if (
      currentStoppingState?.kind === 'replacement' &&
      currentStoppingState.runId === manualStop.runId &&
      currentStoppingState.intentGeneration > manualStop.intentGeneration
    ) {
      currentStoppingState.stopConfirmed = true;
    }
    if (
      currentStoppingState &&
      currentStoppingState.intentGeneration > manualStop.intentGeneration
    ) {
      if (
        runtimeRun?.providerId === 'opencode' &&
        this.runtimeAdapterRunByTeam.get(teamName)?.runId === runtimeRun.runId
      ) {
        await this.finalizeConfirmedOpenCodeRuntimeStop(teamName, runtimeRun.runId);
      }
      return;
    }
    const currentRuntimeRun = this.runtimeAdapterRunByTeam.get(teamName);
    if (currentRuntimeRun?.providerId === 'opencode') {
      if (currentRuntimeRun.runId !== runtimeRun?.runId) {
        await this.withTeamLock(teamName, async () => {
          const lockedRuntimeRun = this.runtimeAdapterRunByTeam.get(teamName);
          if (lockedRuntimeRun?.providerId === 'opencode') {
            await this.stopOpenCodeRuntimeAdapterTeam(teamName, lockedRuntimeRun.runId);
            await this.finalizeConfirmedOpenCodeRuntimeStop(teamName, lockedRuntimeRun.runId);
          }
        });
      } else {
        await this.finalizeConfirmedOpenCodeRuntimeStop(teamName, currentRuntimeRun.runId);
      }
    }
    if (
      this.stoppingPrimaryRuntimeTeams.get(teamName) === manualStop &&
      this.runtimeAdapterRunByTeam.get(teamName)?.providerId !== 'opencode'
    ) {
      this.stoppingPrimaryRuntimeTeams.delete(teamName);
    }
  }

  private async finalizeConfirmedOpenCodeRuntimeStop(
    teamName: string,
    runId: string
  ): Promise<void> {
    await this.cancellationBoundary.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId);
    const progress = this.runtimeAdapterProgressByRunId.get(runId);
    if (
      this.runtimeAdapterRunByTeam.get(teamName)?.runId !== runId &&
      progress?.state === 'disconnected' &&
      progress.message === 'Stopping OpenCode team through runtime adapter'
    ) {
      this.toolApprovalFacade.clearOpenCodeRuntimeToolApprovals(teamName, {
        runId,
        laneId: 'primary',
        emitDismiss: true,
      });
      this.runtimeAdapterProgressState.setRuntimeAdapterProgress({
        ...progress,
        message: 'OpenCode team stopped',
        updatedAt: nowIso(),
      });
      this.teamChangeEmitter?.({
        type: 'process',
        teamName,
        runId,
        detail: 'stopped',
      });
    }
  }

  protected override stopOpenCodeRuntimeAdapterTeam(
    teamName: string,
    runId: string
  ): Promise<void> {
    const teamKey = teamName.trim().toLowerCase();
    const existingStop = this.openCodeRuntimeAdapterStopInFlightByTeam.get(teamKey);
    if (existingStop) {
      if (existingStop.runId === runId) {
        return existingStop.promise;
      }
      return existingStop.promise.then(() => this.stopOpenCodeRuntimeAdapterTeam(teamName, runId));
    }

    const cancelledRestartAtStop = this.openCodeAggregatePrimaryRestartByTeam.get(teamKey);
    const promise = this.stopOpenCodeRuntimeAdapterTeamWithGuards(teamName, runId)
      .finally(async () => {
        if (cancelledRestartAtStop?.runId === runId && cancelledRestartAtStop.cancelRequested) {
          await this.clearCancelledOpenCodeAggregateRestartState(
            teamName,
            runId,
            cancelledRestartAtStop
          );
        }
      })
      .finally(() => {
        if (this.openCodeRuntimeAdapterStopInFlightByTeam.get(teamKey)?.promise === promise) {
          this.openCodeRuntimeAdapterStopInFlightByTeam.delete(teamKey);
        }
      });
    this.openCodeRuntimeAdapterStopInFlightByTeam.set(teamKey, { teamName, runId, promise });
    return promise;
  }

  private async stopOpenCodeRuntimeAdapterTeamWithGuards(
    teamName: string,
    runId: string
  ): Promise<void> {
    const launchIntent = this.primaryRuntimeLaunchIntent.getStore();
    if (launchIntent?.teamName === teamName) {
      launchIntent.stopStarted = true;
    }
    const stoppingState = this.beginPrimaryRuntimeStop(
      teamName,
      runId,
      'replacement',
      launchIntent?.teamName === teamName ? launchIntent.generation : undefined
    );
    const stopKey = `${teamName}\u0000${runId}`;
    let stopPromise = this.primaryRuntimeStopInFlightByRun.get(stopKey);
    if (!stopPromise) {
      stoppingState.stopConfirmed = false;
      stopPromise = super.stopOpenCodeRuntimeAdapterTeam(teamName, runId);
      this.primaryRuntimeStopInFlightByRun.set(stopKey, stopPromise);
    }
    try {
      await stopPromise;
      const currentStoppingState = this.stoppingPrimaryRuntimeTeams.get(teamName);
      if (currentStoppingState === stoppingState) {
        stoppingState.stopConfirmed = true;
      } else if (
        currentStoppingState?.kind === 'replacement' &&
        currentStoppingState.runId === runId &&
        currentStoppingState.intentGeneration > stoppingState.intentGeneration
      ) {
        currentStoppingState.stopConfirmed = true;
      }
    } finally {
      if (this.primaryRuntimeStopInFlightByRun.get(stopKey) === stopPromise) {
        this.primaryRuntimeStopInFlightByRun.delete(stopKey);
      }
    }
  }

  override async deliverOpenCodeMemberMessage(
    teamName: string,
    input: OpenCodeMemberMessageDeliveryInput
  ): Promise<OpenCodeMemberInboxDelivery> {
    const rejection = getOpenCodeAggregatePrimaryDeliveryRejection({
      stopRequested: this.isTeamStopRequested(teamName),
      primaryRuntimeStopping: this.stoppingPrimaryRuntimeTeams.has(teamName),
      hasSecondaryRuntime: this.hasSecondaryRuntimeRuns(teamName),
    });
    if (rejection) {
      return rejection;
    }
    const delivery = await super.deliverOpenCodeMemberMessage(teamName, input);
    if (
      !delivery.delivered &&
      delivery.diagnostics?.length === 1 &&
      delivery.diagnostics[0] === 'opencode_runtime_not_active'
    ) {
      return { delivered: false, reason: 'opencode_runtime_not_active' };
    }
    return delivery;
  }

  override isTeamAlive(teamName: string): boolean {
    const runId = this.runTracking.getAliveRunId(teamName);
    const stoppingState = this.stoppingPrimaryRuntimeTeams.get(teamName);
    return isOpenCodeAggregateTeamAlive({
      stopRequested: this.isTeamStopRequested(teamName),
      runId,
      stoppingRunId: stoppingState?.stopConfirmed ? null : (stoppingState?.runId ?? null),
      primaryRuntimeOwned: this.runtimeAdapterRunByTeam.get(teamName)?.runId === runId,
      secondaryRuntimeOwned: this.hasSecondaryRuntimeRuns(teamName),
      runtimeProgressState: runId
        ? this.runtimeAdapterProgressByRunId.get(runId)?.state
        : undefined,
      run: runId ? this.runs.get(runId) : undefined,
    });
  }

  override getAliveTeams(): string[] {
    return super.getAliveTeams().filter((teamName) => this.isTeamAlive(teamName));
  }

  protected override async sendOpenCodeMemberMessageToRuntimeSerialized(input: {
    teamName: string;
    laneId: string;
    memberName?: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }): Promise<OpenCodeTeamRuntimeMessageResult> {
    const hasTrackedRuntimeOwner =
      Boolean(this.runTracking.getTrackedRunId(input.teamName)) ||
      this.runtimeAdapterRunByTeam.has(input.teamName);
    if (
      hasTrackedRuntimeOwner &&
      !this.runTracking.resolveDeliverableTrackedRuntimeRunId(input.teamName)
    ) {
      return {
        ok: false,
        providerId: 'opencode',
        memberName: input.memberName?.trim() || 'team-lead',
        diagnostics: ['opencode_primary_runtime_not_deliverable'],
      };
    }
    const memberName = input.memberName?.trim().toLowerCase();
    return await super.sendOpenCodeMemberMessageToRuntimeSerialized({
      teamName: input.teamName,
      laneId: memberName ? JSON.stringify([input.laneId.trim(), memberName]) : input.laneId,
      send: async () => {
        if (this.stoppingPrimaryRuntimeTeams.has(input.teamName)) {
          return {
            ok: false,
            providerId: 'opencode',
            memberName: '',
            diagnostics: ['opencode_runtime_not_active'],
          };
        }
        return await input.send();
      },
    });
  }

  async createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    const generation = this.nextPrimaryRuntimeIntentGeneration();
    const launchIntent: PrimaryRuntimeLaunchIntent = {
      teamName: request.teamName,
      generation,
      admissionCommitted: false,
      stopStarted: false,
      previousStoppingState: undefined,
      replacementStoppingState: undefined,
    };
    return await this.primaryRuntimeLaunchIntent.run(launchIntent, async () => {
      try {
        await this.waitForOpenCodeAggregatePrimaryRestart(request.teamName);
        await this.waitForMemberLifecycleOperations(request.teamName);
        const response = await this.requestAdmissionBoundary.createTeam(request, onProgress);
        this.clearPrimaryRuntimeStopAfterMatchingRelaunch(
          request.teamName,
          response.runId,
          generation
        );
        return response;
      } finally {
        this.rollbackUncommittedPrimaryRuntimeRelaunchIntent(launchIntent);
      }
    });
  }

  async launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    const generation = this.nextPrimaryRuntimeIntentGeneration();
    const launchIntent: PrimaryRuntimeLaunchIntent = {
      teamName: request.teamName,
      generation,
      admissionCommitted: false,
      stopStarted: false,
      previousStoppingState: undefined,
      replacementStoppingState: undefined,
    };
    return await this.primaryRuntimeLaunchIntent.run(launchIntent, async () => {
      try {
        await this.waitForOpenCodeAggregatePrimaryRestart(request.teamName);
        await this.waitForMemberLifecycleOperations(request.teamName);
        const response = await this.requestAdmissionBoundary.launchTeam(request, onProgress);
        this.clearPrimaryRuntimeStopAfterMatchingRelaunch(
          request.teamName,
          response.runId,
          generation
        );
        return response;
      } finally {
        this.rollbackUncommittedPrimaryRuntimeRelaunchIntent(launchIntent);
      }
    });
  }
}
