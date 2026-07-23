import { buildOpenCodeSecondaryLaneId } from '@features/team-runtime-lanes';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { clearBootstrapState } from '../TeamBootstrapStateReader';
import { type TeamLaunchStateStore } from '../TeamLaunchStateStore';

import { type TeamProvisioningMemberLifecycleController } from './TeamProvisioningMemberLifecycle';
import {
  type LiveRosterAttachReason,
  type ProvisioningRun as MemberLifecycleProvisioningRun,
} from './TeamProvisioningMemberLifecycleTypes';
import {
  hasRetainableOpenCodeRuntimeMember,
  isRecoverableOpenCodeRuntimeEvidence,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { nowIso } from './TeamProvisioningRunProgress';
import { type MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import {
  type OpenCodeAggregatePrimaryRestartLease,
  TeamProvisioningServiceMemberLifecycleFacade,
} from './TeamProvisioningServiceMemberLifecycleFacade';

import type {
  OpenCodeTeamRuntimeMessageResult,
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
} from '../runtime';
import type { RetryFailedOpenCodeSecondaryLanesResult, TeamCreateRequest } from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

function assertAggregatePrimaryStopConfirmed(result: {
  stopped: boolean;
  diagnostics: string[];
  warnings: string[];
}): void {
  if (result.stopped) {
    return;
  }
  const detail = [...result.diagnostics, ...result.warnings]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join('; ');
  throw new Error(
    detail
      ? `OpenCode primary lane did not confirm stop: ${detail}`
      : 'OpenCode primary lane did not confirm stop'
  );
}

/** Owns serialized lifecycle and aggregate-primary restart orchestration. */
export abstract class TeamProvisioningOpenCodeAggregatePrimaryFacade extends TeamProvisioningServiceMemberLifecycleFacade {
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

  protected async waitForMemberLifecycleOperations(teamName: string): Promise<void> {
    const teamKey = teamName.trim().toLowerCase();
    const completions = Array.from(this.memberLifecycleCompletionByKey.values())
      .filter((entry) => entry.teamKey === teamKey)
      .map((entry) => entry.completion);
    const failedLaneRetry = Array.from(
      this.failedOpenCodeSecondaryRetryInFlightByTeam.entries()
    ).find(([candidateTeamName]) => candidateTeamName.trim().toLowerCase() === teamKey)?.[1];
    if (failedLaneRetry) {
      completions.push(
        failedLaneRetry.then(
          () => undefined,
          () => undefined
        )
      );
    }
    await Promise.all(completions);
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
    const teamKey = teamName.trim().toLowerCase();
    const activeRestart = this.openCodeAggregatePrimaryRestartByTeam.get(teamKey);
    if (activeRestart) {
      throw new Error(
        `OpenCode aggregate primary restart for teammate "${activeRestart.memberName}" is already in progress for team "${teamName}"`
      );
    }

    const memberKey = `${teamKey}\0${memberName.trim().toLowerCase()}`;
    const precedingLifecycleOperations = Array.from(this.memberLifecycleCompletionByKey.entries())
      .filter(([operationKey, entry]) => entry.teamKey === teamKey && operationKey !== memberKey)
      .map(([, entry]) => entry.completion);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const lease: OpenCodeAggregatePrimaryRestartLease = {
      teamName,
      runId,
      memberName,
      completion,
      precedingLifecycleOperations,
      cancelRequested: false,
    };
    this.openCodeAggregatePrimaryRestartByTeam.set(teamKey, lease);
    return {
      lease,
      release: () => {
        resolveCompletion();
        if (this.openCodeAggregatePrimaryRestartByTeam.get(teamKey) === lease) {
          this.openCodeAggregatePrimaryRestartByTeam.delete(teamKey);
        }
      },
    };
  }

  private isOpenCodeAggregatePrimaryRestartCandidate(
    teamName: string,
    memberName: string
  ): { runId: string; run: ProvisioningRun | null } | null {
    const runtimeRun = this.runtimeAdapterRunByTeam.get(teamName);
    if (runtimeRun?.providerId !== 'opencode') {
      return null;
    }
    const aliveRunId = this.runTracking.getAliveRunId(teamName);
    const run = aliveRunId ? (this.runs.get(aliveRunId) ?? null) : null;
    if (!run || run.processKilled || run.cancelRequested) {
      return { runId: runtimeRun.runId, run: null };
    }
    const normalizedMemberName = memberName.trim().toLowerCase();
    const memberHasSecondaryLane = run.mixedSecondaryLanes.some(
      (lane) => lane.member.name.trim().toLowerCase() === normalizedMemberName
    );
    return memberHasSecondaryLane ? null : { runId: run.runId, run };
  }

  protected async waitForOpenCodeAggregatePrimaryRestart(
    teamName: string,
    currentMemberName?: string
  ): Promise<string | null> {
    const restart = this.openCodeAggregatePrimaryRestartByTeam.get(teamName.trim().toLowerCase());
    if (!restart) {
      return null;
    }
    if (restart.memberName.trim().toLowerCase() === currentMemberName?.trim().toLowerCase()) {
      return restart.runId;
    }
    await restart.completion;
    return restart.runId;
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
    await this.enqueueLaunchStateStoreOperation(teamName, async () => {
      const trackedRunId = this.runTracking.getTrackedRunId(teamName);
      if (trackedRunId && trackedRunId !== expectedRunId) {
        return;
      }
      const lastWrittenRunId = this.launchStateWrittenRunIdByTeam.get(teamName);
      if (lastWrittenRunId && lastWrittenRunId !== expectedRunId) {
        return;
      }
      const ownedByExpectedRunWrite = lastWrittenRunId === expectedRunId;
      const cancelledRestart = this.openCodeAggregatePrimaryRestartByTeam.get(
        teamName.trim().toLowerCase()
      );
      const ownedByCancelledRestart =
        (cancelledRestart?.runId === expectedRunId && cancelledRestart.cancelRequested) ||
        (confirmedCancelledRestart?.runId === expectedRunId &&
          confirmedCancelledRestart.cancelRequested);
      const snapshot = await this.launchStateStore.read(teamName).catch(() => null);
      const persistedPrimaryRunIds = new Set(
        Object.values(snapshot?.members ?? {})
          .filter((member) => member.laneId === 'primary' || member.laneKind === 'primary')
          .map((member) => member.runtimeRunId?.trim())
          .filter((candidateRunId): candidateRunId is string => Boolean(candidateRunId))
      );
      if (
        !ownedByExpectedRunWrite &&
        !ownedByCancelledRestart &&
        (persistedPrimaryRunIds.size !== 1 || !persistedPrimaryRunIds.has(expectedRunId))
      ) {
        return;
      }
      await this.launchStateStore.clear(teamName);
      this.launchStateWrittenRunIdByTeam.delete(teamName);
      await clearBootstrapState(teamName);
      this.invalidateRuntimeSnapshotCaches(teamName);
    });
  }

  private getCancelledOpenCodeAggregateRestartError(teamName: string, memberName: string): Error {
    return new Error(
      `OpenCode aggregate primary restart for teammate "${memberName}" was cancelled because team "${teamName}" is no longer running`
    );
  }

  private getCancelledOpenCodeAggregatePrimaryLaunchError(teamName: string): Error {
    return new Error(
      `OpenCode aggregate primary launch for team "${teamName}" was cancelled because the owning run is no longer active`
    );
  }

  private async restartPureOpenCodeAggregatePrimaryMemberExclusive(params: {
    teamName: string;
    memberName: string;
    run: ProvisioningRun;
    restartLease: OpenCodeAggregatePrimaryRestartLease;
  }): Promise<void> {
    const { teamName, memberName, run, restartLease } = params;
    const normalizedMemberName = memberName.trim().toLowerCase();
    const primaryMember = run.effectiveMembers.find(
      (member) => member.name.trim().toLowerCase() === normalizedMemberName
    );
    if (!primaryMember) {
      await this.memberLifecycleController.restartMember(teamName, memberName);
      return;
    }
    if (run.pendingMemberRestarts.has(memberName)) {
      throw new Error(`Restart for teammate "${memberName}" is already in progress`);
    }
    const adapter = this.appShellBoundary.getOpenCodeRuntimeAdapter();
    if (!adapter) {
      throw new Error('OpenCode runtime adapter is not available for member restart.');
    }

    const restartNoLongerCurrent = (): boolean =>
      restartLease.cancelRequested ||
      run.processKilled ||
      run.cancelRequested ||
      this.runs.get(run.runId) !== run;
    const assertRestartCurrent = (): void => {
      if (restartNoLongerCurrent()) {
        throw this.getCancelledOpenCodeAggregateRestartError(teamName, memberName);
      }
    };
    const assertRestartCurrentAfterPersistence = async (): Promise<void> => {
      if (restartNoLongerCurrent()) {
        await this.clearCancelledOpenCodeAggregateRestartState(teamName, run.runId);
      }
      assertRestartCurrent();
    };

    const previousLaunchState = await this.launchStateStore.read(teamName);
    assertRestartCurrent();
    const previousEffectiveMembers = [...run.effectiveMembers];
    const previousExpectedMembers = [...run.expectedMembers];
    const previousSecondaryLanes = [...run.mixedSecondaryLanes];
    const leadMemberName = this.getRunLeadName(run).trim().toLowerCase();
    const hasRetainablePrimaryLead = (result: TeamRuntimeLaunchResult | null): boolean => {
      if (!result) {
        return false;
      }
      const leadEvidence = Object.entries(result.members).find(
        ([name, evidence]) =>
          (evidence.memberName?.trim() || name.trim()).toLowerCase() === leadMemberName
      )?.[1];
      return Boolean(
        leadEvidence &&
        leadEvidence.launchState !== 'failed_to_start' &&
        leadEvidence.hardFailure !== true &&
        isRecoverableOpenCodeRuntimeEvidence(leadEvidence)
      );
    };

    const currentPrimaryRun = this.runtimeAdapterRunByTeam.get(teamName);
    const assertPrimaryRuntimeOwnerCurrent = (): void => {
      if (
        currentPrimaryRun?.providerId !== 'opencode' ||
        currentPrimaryRun.runId !== run.runId ||
        this.runtimeAdapterRunByTeam.get(teamName) !== currentPrimaryRun
      ) {
        throw this.getCancelledOpenCodeAggregateRestartError(teamName, memberName);
      }
    };
    assertPrimaryRuntimeOwnerCurrent();
    const localModelPreflight = await adapter.preflightLocalModels?.({
      targets: [
        {
          projectPath: run.request.cwd,
          modelRoute: run.request.model?.trim() ?? '',
        },
        ...run.effectiveMembers.map((member) => ({
          projectPath: member.cwd?.trim() || run.request.cwd,
          modelRoute: member.model?.trim() ?? '',
        })),
      ],
    });
    assertRestartCurrent();
    assertPrimaryRuntimeOwnerCurrent();
    if (localModelPreflight && !localModelPreflight.ok) {
      throw new Error(
        localModelPreflight.diagnostics[0] ??
          `Local model for teammate "${memberName}" is not ready for restart.`
      );
    }
    if (localModelPreflight?.warnings.length) {
      logger.warn(
        `[${teamName}] Local model aggregate restart preflight warnings for ${memberName}: ${localModelPreflight.warnings.join(' ')}`
      );
    }

    if (currentPrimaryRun?.providerId === 'opencode' && currentPrimaryRun.runId === run.runId) {
      await this.stopOpenCodeRuntimeAdapterTeam(teamName, run.runId);
      assertRestartCurrent();
      this.runTracking.setAliveRunId(teamName, run.runId);
    }

    run.effectiveMembers = run.effectiveMembers.filter(
      (member) => member.name.trim().toLowerCase() !== normalizedMemberName
    );
    run.expectedMembers = run.expectedMembers.filter(
      (name) => name.trim().toLowerCase() !== normalizedMemberName
    );
    const lane: MixedSecondaryRuntimeLaneState = {
      laneId: buildOpenCodeSecondaryLaneId(primaryMember),
      providerId: 'opencode',
      member: { ...primaryMember },
      runId: null,
      state: 'queued',
      result: null,
      warnings: [],
      diagnostics: ['controlled_reattach:manual_restart', 'migrated_from_failed_primary_lane'],
    };
    run.mixedSecondaryLanes = [...run.mixedSecondaryLanes, lane];
    this.memberLifecycleUseCases.persistOpenCodeMemberRestartSystemMessage({
      teamName,
      leadName: this.getRunLeadName(run),
      leadSessionId: run.detectedSessionId?.trim() || run.runId,
      displayName: run.request.displayName?.trim() || run.teamName,
      member: primaryMember,
      reason: 'manual_restart',
      assertStillCurrent: assertRestartCurrent,
    });
    this.invalidateRuntimeSnapshotCaches(teamName);
    this.resetRuntimeToolActivity(run, memberName);
    this.clearMemberSpawnToolTracking(run, memberName);

    let primaryRelaunchResult: TeamRuntimeLaunchResult | null;
    try {
      primaryRelaunchResult = await this.launchOpenCodeAggregatePrimaryLane({
        run,
        adapter,
        prompt: '',
        previousLaunchState,
        assertStillCurrentAfterPersistence: assertRestartCurrent,
      });
      if (restartNoLongerCurrent()) {
        await this.stopUnretainableOpenCodePrimaryLane({
          adapter,
          run,
          previousEffectiveMembers,
          previousLaunchState,
        });
        await this.clearCancelledOpenCodeAggregateRestartState(teamName, run.runId);
        throw this.getCancelledOpenCodeAggregatePrimaryLaunchError(teamName);
      }
      if (!hasRetainablePrimaryLead(primaryRelaunchResult)) {
        throw new Error('OpenCode primary member restart did not retain the team lead runtime.');
      }
    } catch (restartError) {
      if (restartNoLongerCurrent()) {
        const abortedByOwnershipGuard = getErrorMessage(restartError).includes(
          'owning run is no longer active'
        );
        if (!abortedByOwnershipGuard) {
          await this.stopUnretainableOpenCodePrimaryLane({
            adapter,
            run,
            previousEffectiveMembers,
            previousLaunchState,
          });
        }
        await this.clearCancelledOpenCodeAggregateRestartState(teamName, run.runId);
        throw abortedByOwnershipGuard
          ? restartError
          : this.getCancelledOpenCodeAggregatePrimaryLaunchError(teamName);
      }
      try {
        await this.stopFailedOpenCodeAggregatePrimaryRelaunchCandidate({
          adapter,
          run,
          previousLaunchState,
          previousOwner: currentPrimaryRun,
        });
      } catch (cleanupError) {
        run.effectiveMembers = previousEffectiveMembers;
        run.expectedMembers = previousExpectedMembers;
        run.mixedSecondaryLanes = previousSecondaryLanes;
        this.invalidateRuntimeSnapshotCaches(teamName);
        throw new Error(
          `OpenCode member restart failed: ${getErrorMessage(restartError)}. Failed primary candidate cleanup prevented rollback: ${getErrorMessage(cleanupError)}`
        );
      }
      run.effectiveMembers = previousEffectiveMembers;
      run.expectedMembers = previousExpectedMembers;
      run.mixedSecondaryLanes = previousSecondaryLanes;
      this.invalidateRuntimeSnapshotCaches(teamName);

      try {
        const rollbackResult = await this.launchOpenCodeAggregatePrimaryLane({
          run,
          adapter,
          prompt: '',
          previousLaunchState,
          assertStillCurrentAfterPersistence: assertRestartCurrent,
        });
        if (restartNoLongerCurrent()) {
          await this.clearCancelledOpenCodeAggregateRestartState(teamName, run.runId);
          throw this.getCancelledOpenCodeAggregatePrimaryLaunchError(teamName);
        }
        if (!hasRetainablePrimaryLead(rollbackResult)) {
          throw new Error('Primary rollback did not restore a retainable OpenCode team lead.');
        }
        await this.persistLaunchStateSnapshot(run, this.getMixedSecondaryLaunchPhase(run));
        await assertRestartCurrentAfterPersistence();
        this.runTracking.setAliveRunId(teamName, run.runId);
        run.progress = this.runtimeAdapterProgressState.setRuntimeAdapterProgress(
          {
            ...run.progress,
            state: 'ready',
            message: 'OpenCode member restart failed; original primary lane was restored',
            messageSeverity: 'warning',
            updatedAt: nowIso(),
            error: undefined,
            cliLogsTail: getErrorMessage(restartError),
          },
          run.onProgress
        );
      } catch (rollbackError) {
        if (restartNoLongerCurrent()) {
          await this.stopUnretainableOpenCodePrimaryLane({
            adapter,
            run,
            previousEffectiveMembers,
            previousLaunchState,
          });
          await this.clearCancelledOpenCodeAggregateRestartState(teamName, run.runId);
          throw rollbackError;
        }
        const restartMessage = getErrorMessage(restartError);
        const rollbackMessage = getErrorMessage(rollbackError);
        await this.stopUnretainableOpenCodePrimaryLane({
          adapter,
          run,
          previousEffectiveMembers,
          previousLaunchState,
        });
        await this.stopMixedSecondaryRuntimeLanes(teamName);
        await this.clearPersistedLaunchState(teamName, { expectedRunId: run.runId }).catch(
          (error: unknown) => {
            logger.warn(
              `[${teamName}] Failed to clear stale launch state after primary rollback failure: ${getErrorMessage(error)}`
            );
          }
        );
        await this.cancellationBoundary.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(
          teamName,
          run.runId
        );
        run.processKilled = true;
        run.progress = this.runtimeAdapterProgressState.setRuntimeAdapterProgress(
          {
            ...run.progress,
            state: 'failed',
            message: 'OpenCode member restart and primary rollback failed',
            messageSeverity: 'error',
            updatedAt: nowIso(),
            error: `${restartMessage} Rollback failed: ${rollbackMessage}`,
            cliLogsTail: `${restartMessage}\n${rollbackMessage}`,
          },
          run.onProgress
        );
        if (this.runs.get(run.runId) === run) {
          this.cleanupRun(run);
        }
        throw new Error(
          `OpenCode member restart failed: ${restartMessage}. Primary rollback failed: ${rollbackMessage}`
        );
      }
      throw restartError;
    }

    await this.launchSingleMixedSecondaryLane(run, lane);
    await assertRestartCurrentAfterPersistence();
    await this.persistLaunchStateSnapshot(run, this.getMixedSecondaryLaunchPhase(run));
    await assertRestartCurrentAfterPersistence();
    if (this.isTeamAlive(teamName)) {
      const memberRestartRetained =
        lane.result != null && hasRetainableOpenCodeRuntimeMember(lane.result);
      const restartRetained =
        memberRestartRetained && hasRetainablePrimaryLead(primaryRelaunchResult);
      run.progress = this.runtimeAdapterProgressState.setRuntimeAdapterProgress(
        {
          ...run.progress,
          state: 'ready',
          message: restartRetained
            ? 'OpenCode member lane restart is ready'
            : 'OpenCode team is running with unavailable members',
          messageSeverity: restartRetained ? undefined : 'warning',
          updatedAt: nowIso(),
          error: undefined,
        },
        run.onProgress
      );
    } else {
      this.runTracking.deleteAliveRunId(teamName);
    }
  }

  private async stopUnretainableOpenCodePrimaryLane(input: {
    adapter: TeamLaunchRuntimeAdapter;
    run: ProvisioningRun;
    previousEffectiveMembers: TeamCreateRequest['members'];
    previousLaunchState: Awaited<ReturnType<TeamLaunchStateStore['read']>>;
  }): Promise<void> {
    const cwd = this.prepareFacade.getOpenCodeRuntimeLaunchCwd(
      input.run.request.cwd,
      input.previousEffectiveMembers
    );
    const currentOwner = this.runtimeAdapterRunByTeam.get(input.run.teamName);
    const exactStopOwner = currentOwner ?? {
      runId: input.run.runId,
      providerId: 'opencode' as const,
      cwd,
    };
    if (!currentOwner) {
      this.runtimeAdapterRunByTeam.set(input.run.teamName, exactStopOwner);
    }
    this.publishAggregatePrimaryPendingStop(
      input.run,
      'Stopping unretainable OpenCode primary lane'
    );
    try {
      const stopResult = await input.adapter.stop({
        runId: input.run.runId,
        laneId: 'primary',
        teamName: input.run.teamName,
        cwd,
        providerId: 'opencode',
        reason: 'cleanup',
        previousLaunchState: input.previousLaunchState,
        force: true,
      });
      assertAggregatePrimaryStopConfirmed(stopResult);
      if (this.runtimeAdapterRunByTeam.get(input.run.teamName) !== exactStopOwner) {
        throw this.getCancelledOpenCodeAggregatePrimaryLaunchError(input.run.teamName);
      }
    } catch (error) {
      if (this.runtimeAdapterRunByTeam.get(input.run.teamName) === exactStopOwner) {
        this.publishAggregatePrimaryFailedStop(
          input.run,
          'Unretainable OpenCode primary lane cleanup failed',
          error
        );
      }
      logger.warn(
        `[${input.run.teamName}] Failed to stop unretainable OpenCode primary lane: ${getErrorMessage(error)}`
      );
      throw error;
    }
  }

  private async stopFailedOpenCodeAggregatePrimaryRelaunchCandidate(input: {
    adapter: TeamLaunchRuntimeAdapter;
    run: ProvisioningRun;
    previousLaunchState: Awaited<ReturnType<TeamLaunchStateStore['read']>>;
    previousOwner:
      | {
          runId: string;
          providerId: string;
          cwd?: string;
        }
      | undefined;
  }): Promise<void> {
    const currentOwner = this.runtimeAdapterRunByTeam.get(input.run.teamName);
    if (
      currentOwner &&
      (currentOwner === input.previousOwner ||
        currentOwner.providerId !== 'opencode' ||
        currentOwner.runId !== input.run.runId)
    ) {
      throw this.getCancelledOpenCodeAggregatePrimaryLaunchError(input.run.teamName);
    }
    const cwd =
      currentOwner?.cwd ??
      this.prepareFacade.getOpenCodeRuntimeLaunchCwd(
        input.run.request.cwd,
        input.run.effectiveMembers
      );
    const expectedOwner = currentOwner ?? {
      runId: input.run.runId,
      providerId: 'opencode' as const,
      cwd,
    };
    if (!currentOwner) {
      this.runtimeAdapterRunByTeam.set(input.run.teamName, expectedOwner);
    }
    this.publishAggregatePrimaryPendingStop(
      input.run,
      'Stopping failed OpenCode primary relaunch candidate'
    );
    try {
      const stopResult = await input.adapter.stop({
        runId: input.run.runId,
        laneId: 'primary',
        teamName: input.run.teamName,
        cwd,
        providerId: 'opencode',
        reason: 'cleanup',
        previousLaunchState: input.previousLaunchState,
        force: true,
      });
      assertAggregatePrimaryStopConfirmed(stopResult);
      if (this.runtimeAdapterRunByTeam.get(input.run.teamName) !== expectedOwner) {
        throw this.getCancelledOpenCodeAggregatePrimaryLaunchError(input.run.teamName);
      }
      this.runtimeAdapterRunByTeam.delete(input.run.teamName);
    } catch (error) {
      if (this.runtimeAdapterRunByTeam.get(input.run.teamName) === expectedOwner) {
        this.publishAggregatePrimaryFailedStop(
          input.run,
          'Failed OpenCode primary relaunch candidate cleanup failed',
          error
        );
      }
      throw error;
    }
  }

  private publishAggregatePrimaryPendingStop(run: ProvisioningRun, message: string): void {
    run.progress = this.publishAggregatePrimaryProgress(run, {
      ...run.progress,
      state: 'disconnected',
      message,
      updatedAt: nowIso(),
    });
    this.invalidateRuntimeSnapshotCaches(run.teamName);
  }

  private publishAggregatePrimaryFailedStop(
    run: ProvisioningRun,
    message: string,
    error: unknown
  ): void {
    run.progress = this.publishAggregatePrimaryProgress(run, {
      ...run.progress,
      state: 'failed',
      message,
      messageSeverity: 'error',
      updatedAt: nowIso(),
      error: getErrorMessage(error),
      cliLogsTail: getErrorMessage(error),
    });
    this.invalidateRuntimeSnapshotCaches(run.teamName);
  }

  private publishAggregatePrimaryProgress(
    run: ProvisioningRun,
    progress: ProvisioningRun['progress']
  ): ProvisioningRun['progress'] {
    if (this.compatibilityDelegation?.retainedProvisioningProgressState) {
      return this.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress, run.onProgress);
    }

    const nextProgress =
      this.runtimeAdapterProgressState.enrichRuntimeAdapterProgressTrace(progress);
    this.runtimeAdapterProgressByRunId.set(nextProgress.runId, nextProgress);
    run.onProgress?.(nextProgress);
    return nextProgress;
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
          throw this.getCancelledOpenCodeAggregateRestartError(teamName, memberName);
        }
      } catch (error) {
        if (restart.lease.cancelRequested) {
          await this.clearCancelledOpenCodeAggregateRestartState(teamName, restart.lease.runId);
          throw this.getCancelledOpenCodeAggregateRestartError(teamName, memberName);
        }
        throw error;
      } finally {
        restart.release();
      }
    });
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

  override async stopTeam(teamName: string): Promise<void> {
    const teamKey = teamName.trim().toLowerCase();
    const aggregateRestart = this.openCodeAggregatePrimaryRestartByTeam.get(teamKey);
    if (aggregateRestart) {
      aggregateRestart.cancelRequested = true;
    }
    const primaryStopInFlight = this.openCodeRuntimeAdapterStopInFlightByTeam.get(teamKey)?.promise;
    try {
      await super.stopTeam(teamName);
    } finally {
      await primaryStopInFlight;
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
    const promise = super
      .stopOpenCodeRuntimeAdapterTeam(teamName, runId)
      .then(async () => {
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

  override isTeamAlive(teamName: string): boolean {
    const runId = this.runTracking.getAliveRunId(teamName);
    if (!runId) {
      return false;
    }
    const hasPrimaryRuntime = this.runtimeAdapterRunByTeam.get(teamName)?.runId === runId;
    const hasSecondaryRuntime = this.hasSecondaryRuntimeRuns(teamName);
    const runtimeProgressState = this.runtimeAdapterProgressByRunId.get(runId)?.state;
    if (
      !hasSecondaryRuntime &&
      (runtimeProgressState === 'disconnected' ||
        runtimeProgressState === 'failed' ||
        runtimeProgressState === 'cancelled')
    ) {
      return false;
    }
    const run = this.runs.get(runId);
    if (!run) {
      return hasPrimaryRuntime || hasSecondaryRuntime;
    }
    if (hasPrimaryRuntime || hasSecondaryRuntime) {
      return !run.processKilled && !run.cancelRequested;
    }
    return run.child != null && !run.processKilled && !run.cancelRequested;
  }

  protected override async sendOpenCodeMemberMessageToRuntimeSerialized(input: {
    teamName: string;
    laneId: string;
    memberName?: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }): Promise<OpenCodeTeamRuntimeMessageResult> {
    if (
      this.runTracking.getTrackedRunId(input.teamName) &&
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
      send: input.send,
    });
  }
}
