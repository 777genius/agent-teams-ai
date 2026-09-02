import * as path from 'path';

import {
  buildOpenCodeAggregateFailureProgress,
  buildOpenCodeAggregateFinalProgress,
  createOpenCodeAggregateProvisioningRun,
  type OpenCodeWorktreeRootAggregateLaunchPorts,
  type OpenCodeWorktreeRootAggregateLaunchPreflightPorts,
  type RunOpenCodeWorktreeRootAggregateLaunchInput,
} from './TeamProvisioningOpenCodeAggregateRunModel';
import {
  deleteOpenCodeAggregateRuntimeTrackingIfOwned,
  stopAndRollbackOpenCodeAggregateRuntimeLanes,
} from './TeamProvisioningOpenCodeAggregateRunRollback';
import { selectOpenCodeLaunchFailureDiagnostic } from './TeamProvisioningOpenCodeDiagnosticsPolicy';
import {
  hasRetainableOpenCodeRuntimeMember,
  markOpenCodeLaneBlockedBySharedRuntimeFailure,
  selectOpenCodeSharedRuntimePreflightFailureDiagnostic,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { TeamRuntimeLaunchResult } from '../runtime';
import type { TeamLaunchResponse, TeamProvisioningProgress } from '@shared/types';

export * from './TeamProvisioningOpenCodeAggregateRunModel';

export async function prepareOpenCodeWorktreeRootAggregateLaunchPreflight(
  input: {
    teamName: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  },
  ports: OpenCodeWorktreeRootAggregateLaunchPreflightPorts
): Promise<TeamLaunchResponse | null> {
  const stopAllGenerationAtStart = ports.getStopAllTeamsGeneration();
  const stopTeamGenerationAtStart = ports.getStopTeamGeneration(input.teamName);
  const recordCancellationIfRequested = (): TeamLaunchResponse | null =>
    ports.getStopAllTeamsGeneration() !== stopAllGenerationAtStart ||
    ports.getStopTeamGeneration(input.teamName) !== stopTeamGenerationAtStart
      ? ports.recordCancelledOpenCodeRuntimeAdapterLaunch(
          input.teamName,
          input.sourceWarning,
          input.onProgress
        )
      : null;
  const previousRuntimeRun = ports.getRuntimeAdapterRun(input.teamName);
  if (previousRuntimeRun?.providerId === 'opencode') {
    await ports.stopOpenCodeRuntimeAdapterTeam(input.teamName, previousRuntimeRun.runId);
    const cancellation = recordCancellationIfRequested();
    if (cancellation) return cancellation;
  }
  if (ports.hasSecondaryRuntimeRuns(input.teamName)) {
    await ports.stopMixedSecondaryRuntimeLanes(input.teamName);
    const cancellation = recordCancellationIfRequested();
    if (cancellation) return cancellation;
  }
  const previousPendingRunId = ports.getProvisioningRun(input.teamName);
  const previousRuntimeProgress = previousPendingRunId
    ? ports.getRuntimeAdapterProgress(previousPendingRunId)
    : undefined;
  if (
    previousPendingRunId &&
    previousRuntimeProgress &&
    ports.isCancellableRuntimeAdapterProgress(previousRuntimeProgress)
  ) {
    await ports.cancelRuntimeAdapterProvisioning(previousPendingRunId, previousRuntimeProgress);
    const cancellation = recordCancellationIfRequested();
    if (cancellation) return cancellation;
  }
  return recordCancellationIfRequested();
}

export async function runOpenCodeWorktreeRootAggregateLaunch(
  input: RunOpenCodeWorktreeRootAggregateLaunchInput,
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): Promise<TeamLaunchResponse> {
  const teamName = input.request.teamName;
  const stopAllGenerationAtStart = ports.getStopAllTeamsGeneration();
  const stopTeamGenerationAtStart = ports.getStopTeamGeneration(teamName);
  const stopRequested = (): boolean =>
    ports.getStopAllTeamsGeneration() !== stopAllGenerationAtStart ||
    ports.getStopTeamGeneration(teamName) !== stopTeamGenerationAtStart;

  // Resolve every lane before any stop, map update, persisted-state clear, or
  // adapter launch. In particular, worktree-shape validation must not discover
  // an invalid side lane after the previous runtime has already been mutated.
  const primaryCwd = path.resolve(
    ports.getOpenCodeRuntimeLaunchCwd(input.request.cwd, input.lanePlan.primaryMembers)
  );
  const secondaryCwds = new Map(
    input.lanePlan.sideLanes.map((lane) => [
      lane.laneId,
      path.resolve(ports.getOpenCodeRuntimeLaunchCwd(input.request.cwd, [lane.member])),
    ])
  );

  const preflightCancellation = await prepareOpenCodeWorktreeRootAggregateLaunchPreflight(
    {
      teamName,
      sourceWarning: input.sourceWarning,
      onProgress: input.onProgress,
    },
    ports
  );
  if (preflightCancellation) {
    return preflightCancellation;
  }
  if (stopRequested()) {
    return ports.recordCancelledOpenCodeRuntimeAdapterLaunch(
      teamName,
      input.sourceWarning,
      input.onProgress
    );
  }

  // This is intentionally the last read-only await before this launch claims
  // team ownership and begins destructive launch-state mutation.
  const previousLaunchState = await ports.readLaunchState(teamName);
  if (stopRequested()) {
    return ports.recordCancelledOpenCodeRuntimeAdapterLaunch(
      teamName,
      input.sourceWarning,
      input.onProgress
    );
  }

  const runId = ports.randomUUID();
  const startedAt = ports.nowIso();
  const initialProgress: TeamProvisioningProgress = {
    runId,
    teamName,
    state: 'validating',
    message: 'Validating OpenCode member lane launch gate',
    startedAt,
    updatedAt: startedAt,
    warnings: input.sourceWarning ? [input.sourceWarning] : undefined,
  };
  ports.setProvisioningRun(teamName, runId);
  const initialRuntimeProgress = ports.setRuntimeAdapterProgress(initialProgress, input.onProgress);
  const run = createOpenCodeAggregateProvisioningRun({
    runId,
    startedAt,
    progress: initialRuntimeProgress,
    request: input.request,
    members: input.members,
    lanePlan: input.lanePlan,
    onProgress: input.onProgress,
  });
  ports.setRun(runId, run);
  ports.resetTeamScopedTransientStateForNewRun(teamName);
  let cancellationConsumed = false;
  let untrackedPrimaryLaunchMayBeRunning = false;
  const aggregateLaunchNoLongerCurrent = (): boolean => {
    cancellationConsumed ||= ports.consumeCancelledRuntimeAdapterRunId(runId);
    const runtimeOwner = ports.getRuntimeAdapterRun(teamName);
    const conflictingRuntimeOwner =
      runtimeOwner !== undefined &&
      (runtimeOwner.providerId !== 'opencode' || runtimeOwner.runId !== runId);
    return (
      cancellationConsumed ||
      run.cancelRequested ||
      run.processKilled ||
      stopRequested() ||
      ports.getProvisioningRun(teamName) !== runId ||
      ports.getRun(runId) !== run ||
      conflictingRuntimeOwner
    );
  };
  const finishCancelledAggregateLaunch = async (): Promise<TeamLaunchResponse> => {
    run.cancelRequested = true;
    run.processKilled = true;
    const rollbackComplete = await stopAndRollbackOpenCodeAggregateRuntimeLanes(
      run,
      {
        adapter: input.adapter,
        previousLaunchState,
        primaryCwd,
        secondaryCwds,
        untrackedPrimaryLaunchMayBeRunning,
      },
      ports
    );
    if (rollbackComplete) {
      await ports
        .clearPersistedLaunchState(teamName, { expectedRunId: runId })
        .catch(() => undefined);
      ports.deleteProvisioningRunIfCurrent(teamName, runId);
      if (ports.getRun(runId) === run) {
        ports.cleanupRun(run);
      }
    }
    ports.invalidateRuntimeSnapshotCaches(teamName);
    return { runId };
  };

  await ports.clearPersistedLaunchState(teamName, { expectedRunId: runId });
  if (aggregateLaunchNoLongerCurrent()) {
    return await finishCancelledAggregateLaunch();
  }
  ports.invalidateRuntimeSnapshotCaches(teamName);

  const launching = ports.setRuntimeAdapterProgress(
    {
      ...initialRuntimeProgress,
      state: 'spawning',
      message: 'Starting OpenCode member runtime lanes',
      updatedAt: ports.nowIso(),
    },
    input.onProgress
  );
  run.progress = launching;

  try {
    untrackedPrimaryLaunchMayBeRunning = true;
    const primaryResult = await ports.launchOpenCodeAggregatePrimaryLane({
      run,
      adapter: input.adapter,
      prompt: input.prompt,
      previousLaunchState,
      assertStillCurrentAfterPersistence: () => {
        if (aggregateLaunchNoLongerCurrent()) {
          throw new Error(
            `OpenCode aggregate primary launch for team "${teamName}" was cancelled because the owning run is no longer active`
          );
        }
      },
    });
    untrackedPrimaryLaunchMayBeRunning = false;
    if (aggregateLaunchNoLongerCurrent()) {
      return await finishCancelledAggregateLaunch();
    }
    if (primaryResult) {
      const primarySharedFailure =
        selectOpenCodeSharedRuntimePreflightFailureDiagnostic(primaryResult);
      if (primarySharedFailure) {
        run.mixedSecondarySharedRuntimeFailuresByProject.set(primaryCwd, primarySharedFailure);
      }
    }
    for (const lane of run.mixedSecondaryLanes) {
      if (aggregateLaunchNoLongerCurrent()) {
        return await finishCancelledAggregateLaunch();
      }
      const laneCwd = secondaryCwds.get(lane.laneId)!;
      const sharedRuntimeFailure = run.mixedSecondarySharedRuntimeFailuresByProject.get(laneCwd);
      if (sharedRuntimeFailure) {
        markOpenCodeLaneBlockedBySharedRuntimeFailure({
          teamName,
          lane,
          rootCause: sharedRuntimeFailure,
          nowMs: ports.nowMs(),
          createRunId: () => ports.randomUUID(),
        });
        await ports.publishMixedSecondaryLaneStatusChange(run, lane);
        if (aggregateLaunchNoLongerCurrent()) {
          return await finishCancelledAggregateLaunch();
        }
        continue;
      }
      await ports.launchSingleMixedSecondaryLane(run, lane);
      if (aggregateLaunchNoLongerCurrent()) {
        return await finishCancelledAggregateLaunch();
      }
      if (lane.result) {
        const laneSharedFailure = selectOpenCodeSharedRuntimePreflightFailureDiagnostic(
          lane.result
        );
        if (laneSharedFailure) {
          run.mixedSecondarySharedRuntimeFailuresByProject.set(laneCwd, laneSharedFailure);
        }
      }
    }

    run.provisioningComplete = true;
    const launchState = ports.summarizeOpenCodeAggregateLaunchState({
      primaryResult,
      lanes: run.mixedSecondaryLanes,
    });
    const launchPhase = launchState === 'partial_pending' ? 'active' : 'finished';
    const snapshot = await ports.persistLaunchStateSnapshot(run, launchPhase);
    if (snapshot) {
      ports.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);
    }
    if (aggregateLaunchNoLongerCurrent()) {
      return await finishCancelledAggregateLaunch();
    }

    const failed = launchState === 'partial_failure';
    const retainableResults = [
      primaryResult,
      ...run.mixedSecondaryLanes.map((lane) => lane.result),
    ].filter((result): result is TeamRuntimeLaunchResult => result !== null);
    const partialTeamCanContinue =
      failed && retainableResults.some((result) => hasRetainableOpenCodeRuntimeMember(result));
    const terminalFailure = failed && !partialTeamCanContinue;
    const laneDiagnostics = run.mixedSecondaryLanes.flatMap((lane) => lane.diagnostics);
    const terminalFailureError = selectOpenCodeLaunchFailureDiagnostic([
      ...retainableResults.flatMap((launchResult) => [
        ...Object.values(launchResult.members).flatMap((member) => [
          member.hardFailureReason,
          member.runtimeDiagnostic,
          ...member.diagnostics,
        ]),
        ...launchResult.diagnostics,
      ]),
      ...laneDiagnostics,
    ]);
    const finalProgress = ports.setRuntimeAdapterProgress(
      buildOpenCodeAggregateFinalProgress({
        launching,
        launchState,
        laneDiagnostics,
        updatedAt: ports.nowIso(),
        partialTeamCanContinue,
        terminalFailureError,
      }),
      input.onProgress
    );
    run.progress = finalProgress;
    let rollbackComplete = true;
    if (!terminalFailure) {
      ports.setAliveRunId(teamName, runId);
    } else {
      // A summarized terminal failure is non-throwing, but it owns the same
      // adapter-managed processes and rollback obligations as the catch path.
      // Stop all lanes before cleanupRun removes their tracking.
      rollbackComplete = await stopAndRollbackOpenCodeAggregateRuntimeLanes(
        run,
        {
          adapter: input.adapter,
          previousLaunchState,
          primaryCwd,
          secondaryCwds,
          untrackedPrimaryLaunchMayBeRunning,
        },
        ports
      );
      if (rollbackComplete) {
        run.progress = ports.setRuntimeAdapterProgress(finalProgress, input.onProgress);
      }
      if (rollbackComplete && aggregateLaunchNoLongerCurrent()) {
        if (ports.getRun(runId) === run) ports.cleanupRun(run);
        return { runId };
      }
      // Terminal failure: tear the run down fully. Removing it from the runs map
      // and clearing its timers/watchdogs/pending approvals (cleanupRun) is what a
      // clean-success run intentionally skips, but a failed one must not leak.
      if (rollbackComplete) {
        deleteOpenCodeAggregateRuntimeTrackingIfOwned(teamName, runId, ports);
        ports.cleanupRun(run);
      }
    }
    if (!terminalFailure || rollbackComplete) {
      ports.deleteProvisioningRunIfCurrent(teamName, runId);
    }
    ports.invalidateRuntimeSnapshotCaches(teamName);
    ports.emitTeamProcessChange({
      type: 'process',
      teamName,
      runId,
      detail: finalProgress.state,
    });
    return { runId };
  } catch (error) {
    if (aggregateLaunchNoLongerCurrent()) {
      return await finishCancelledAggregateLaunch();
    }
    // Genuine launch error after lanes came up: stop the owned primary OpenCode
    // adapter process (and any secondary lanes) BEFORE clearing their storage.
    // The adapter-managed process is not covered by run.child (null), so without
    // an explicit stop it is orphaned when the maps/storage below are cleared.
    const rollbackComplete = await stopAndRollbackOpenCodeAggregateRuntimeLanes(
      run,
      {
        adapter: input.adapter,
        previousLaunchState,
        primaryCwd,
        secondaryCwds,
        untrackedPrimaryLaunchMayBeRunning,
      },
      ports
    );
    if (rollbackComplete && aggregateLaunchNoLongerCurrent()) {
      if (ports.getRun(runId) === run) ports.cleanupRun(run);
      return { runId };
    }
    const message = error instanceof Error ? error.message : String(error);
    const failedProgress = ports.setRuntimeAdapterProgress(
      buildOpenCodeAggregateFailureProgress({
        launching,
        message,
        updatedAt: ports.nowIso(),
      }),
      input.onProgress
    );
    run.progress = failedProgress;
    if (rollbackComplete) {
      deleteOpenCodeAggregateRuntimeTrackingIfOwned(teamName, runId, ports);
      ports.deleteProvisioningRunIfCurrent(teamName, runId);
    }
    // Genuine launch error: remove the run from the runs map and clear its
    // timers/watchdogs/pending approvals so a failed aggregate launch does not
    // leak a dead run (cleanupRun internally no-ops team-scoped work if a newer
    // run has since taken over).
    if (rollbackComplete) {
      ports.cleanupRun(run);
    }
    ports.invalidateRuntimeSnapshotCaches(teamName);
    throw error;
  }
}
