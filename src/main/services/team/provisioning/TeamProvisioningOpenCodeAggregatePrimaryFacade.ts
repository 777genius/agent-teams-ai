import { buildOpenCodeSecondaryLaneId } from '@features/team-runtime-lanes';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { clearBootstrapState } from '../TeamBootstrapStateReader';
import { type TeamLaunchStateStore } from '../TeamLaunchStateStore';

import {
  getPendingOpenCodePrimaryCleanupIdentity,
  type PendingOpenCodePrimaryCleanup,
} from './TeamProvisioningLaunchStateStoreBoundary';
import { type TeamProvisioningMemberLifecycleController } from './TeamProvisioningMemberLifecycle';
import {
  type LiveRosterAttachReason,
  type ProvisioningRun as MemberLifecycleProvisioningRun,
} from './TeamProvisioningMemberLifecycleTypes';
import { OpenCodeAggregateRuntimeStopError } from './TeamProvisioningOpenCodeAggregateLaunchPersistence';
import {
  hasRetainableOpenCodeRuntimeMember,
  isRecoverableOpenCodeRuntimeEvidence,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { nowIso } from './TeamProvisioningRunProgress';
import { type MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
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
import type {
  OpenCodeTeamRuntimeMessageResult,
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
} from '../runtime';
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
      this.clearPrimaryRuntimeStopAfterMatchingRelaunch(teamName, run.runId);
    } catch (restartError) {
      if (restartNoLongerCurrent()) {
        const abortedByOwnershipGuard = getErrorMessage(restartError).includes(
          'owning run is no longer active'
        );
        const cleanupUnconfirmed = restartError instanceof OpenCodeAggregateRuntimeStopError;
        if (!abortedByOwnershipGuard && !cleanupUnconfirmed) {
          await this.stopUnretainableOpenCodePrimaryLane({
            adapter,
            run,
            previousEffectiveMembers,
            previousLaunchState,
          });
        }
        if (!cleanupUnconfirmed) {
          await this.clearCancelledOpenCodeAggregateRestartState(teamName, run.runId);
        }
        throw abortedByOwnershipGuard || cleanupUnconfirmed
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
        this.clearPrimaryRuntimeStopAfterMatchingRelaunch(teamName, run.runId);
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
    try {
      const result = await input.adapter.stop({
        runId: input.run.runId,
        laneId: 'primary',
        teamName: input.run.teamName,
        cwd,
        providerId: 'opencode',
        reason: 'cleanup',
        previousLaunchState: input.previousLaunchState,
        force: true,
      });
      if (!result.stopped) {
        throw new Error(
          [...result.diagnostics, ...result.warnings].filter(Boolean).join('\n') ||
            'OpenCode unretainable primary lane stop was not confirmed'
        );
      }
    } catch (error) {
      // Persistence has already committed the cancelled candidate by the time
      // this cleanup runs. Record the rejected generation independently so a
      // successor owner cannot conceal it and a later retry can target only
      // the old run without replacing or clearing the successor.
      const cleanup: PendingOpenCodePrimaryCleanup = {
        teamId: input.run.teamName,
        runId: input.run.runId,
        providerId: 'opencode',
        cwd,
        previousLaunchState: input.previousLaunchState,
      };
      let outboxError: unknown;
      try {
        await this.appendPendingOpenCodePrimaryCleanup(cleanup);
      } catch (caughtOutboxError) {
        outboxError = caughtOutboxError;
      }
      if (!this.runtimeAdapterRunByTeam.has(input.run.teamName)) {
        this.runtimeAdapterRunByTeam.set(input.run.teamName, {
          runId: input.run.runId,
          providerId: 'opencode',
          cwd,
        });
      }
      logger.warn(
        `[${input.run.teamName}] Failed to stop unretainable OpenCode primary lane: ${getErrorMessage(error)}`
      );
      throw new OpenCodeAggregateRuntimeStopError(
        outboxError === undefined ? [error] : [error, outboxError]
      );
    }
  }

  protected async retryPendingOpenCodePrimaryCleanup(teamName: string): Promise<void> {
    const pendingCleanups = (await this.readPendingOpenCodePrimaryCleanups(teamName))
      .map((cleanup) => [getPendingOpenCodePrimaryCleanupIdentity(cleanup), cleanup] as const)
      .sort(([leftIdentity], [rightIdentity]) => {
        if (leftIdentity === rightIdentity) {
          return 0;
        }
        return leftIdentity < rightIdentity ? -1 : 1;
      });
    if (pendingCleanups.length === 0) {
      return;
    }

    const adapter = this.appShellBoundary.getOpenCodeRuntimeAdapter();
    if (!adapter) {
      throw new OpenCodeAggregateRuntimeStopError([
        new Error('OpenCode runtime adapter is unavailable for pending primary cleanup'),
      ]);
    }

    for (const [, cleanup] of pendingCleanups) {
      try {
        const result = await adapter.stop({
          runId: cleanup.runId,
          laneId: 'primary',
          teamName: cleanup.teamId,
          cwd: cleanup.cwd,
          providerId: cleanup.providerId,
          reason: 'cleanup',
          previousLaunchState: cleanup.previousLaunchState,
          force: true,
        });
        if (!result.stopped) {
          throw new Error(
            [...result.diagnostics, ...result.warnings].filter(Boolean).join('\n') ||
              'OpenCode pending primary cleanup was not confirmed'
          );
        }
      } catch (error) {
        logger.warn(
          `[${cleanup.teamId}] Failed to retry pending OpenCode primary cleanup for run ${cleanup.runId}: ${getErrorMessage(error)}`
        );
        throw new OpenCodeAggregateRuntimeStopError([error]);
      }

      await this.consumePendingOpenCodePrimaryCleanup(cleanup);
      const currentOwner = this.runtimeAdapterRunByTeam.get(cleanup.teamId);
      if (
        currentOwner?.runId === cleanup.runId &&
        currentOwner.providerId === cleanup.providerId &&
        currentOwner.cwd === cleanup.cwd
      ) {
        await this.cancellationBoundary.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(
          cleanup.teamId,
          cleanup.runId
        );
      }
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
    const expectedOwner = currentOwner;
    await input.adapter.stop({
      runId: input.run.runId,
      laneId: 'primary',
      teamName: input.run.teamName,
      cwd:
        expectedOwner?.cwd ??
        this.prepareFacade.getOpenCodeRuntimeLaunchCwd(
          input.run.request.cwd,
          input.run.effectiveMembers
        ),
      providerId: 'opencode',
      reason: 'cleanup',
      previousLaunchState: input.previousLaunchState,
      force: true,
    });
    if (expectedOwner && this.runtimeAdapterRunByTeam.get(input.run.teamName) !== expectedOwner) {
      throw this.getCancelledOpenCodeAggregatePrimaryLaunchError(input.run.teamName);
    }
    if (expectedOwner) {
      this.runtimeAdapterRunByTeam.delete(input.run.teamName);
    }
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
          throw this.getCancelledOpenCodeAggregateRestartError(teamName, memberName);
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
          throw this.getCancelledOpenCodeAggregateRestartError(teamName, memberName);
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
    if (this.stoppingPrimaryRuntimeTeams.has(teamName)) {
      return { delivered: false, reason: 'opencode_runtime_not_active' };
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
    if (!runId) {
      return false;
    }
    const stoppingState = this.stoppingPrimaryRuntimeTeams.get(teamName);
    if (stoppingState?.runId === runId && !stoppingState.stopConfirmed) {
      return true;
    }
    const hasPrimaryRuntime = this.runtimeAdapterRunByTeam.get(teamName)?.runId === runId;
    const run = this.runs.get(runId);
    if (!run) {
      if (hasPrimaryRuntime && this.runtimeAdapterProgressByRunId.get(runId)?.state === 'failed') {
        return false;
      }
      return hasPrimaryRuntime || this.hasSecondaryRuntimeRuns(teamName);
    }
    if (run.processKilled || run.cancelRequested) {
      return false;
    }
    if (hasPrimaryRuntime) {
      const runtimeProgress = this.runtimeAdapterProgressByRunId.get(runId) ?? run.progress;
      return runtimeProgress.state !== 'failed';
    }
    if (this.hasSecondaryRuntimeRuns(teamName)) {
      return true;
    }
    return run.child != null;
  }

  protected override async sendOpenCodeMemberMessageToRuntimeSerialized(input: {
    teamName: string;
    laneId: string;
    memberName?: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }): Promise<OpenCodeTeamRuntimeMessageResult> {
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
