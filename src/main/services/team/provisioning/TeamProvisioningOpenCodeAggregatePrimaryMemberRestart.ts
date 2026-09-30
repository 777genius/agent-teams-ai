import { buildOpenCodeSecondaryLaneId } from '@features/team-runtime-lanes';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import {
  getCancelledAggregateLaunchError,
  getCancelledAggregateRestartError,
} from './OpenCodeAggregatePrimaryRestartPolicy';
import { OpenCodeAggregateRuntimeStopError } from './TeamProvisioningOpenCodeAggregateLaunchPersistence';
import {
  hasRetainableOpenCodeRuntimeMember,
  isRecoverableOpenCodeRuntimeEvidence,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { nowIso } from './TeamProvisioningRunProgress';

import type { TeamLaunchRuntimeAdapter, TeamRuntimeLaunchResult } from '../runtime';
import type { OpenCodeAggregatePrimaryRuntimeOwner } from './TeamProvisioningOpenCodeAggregatePrimaryCleanup';
import type { OpenCodeMemberRestartSystemMessageInput } from './TeamProvisioningOpenCodeMemberRestartSystemMessageUseCase';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type { OpenCodeAggregatePrimaryRestartLease } from './TeamProvisioningServiceRuntimeStateFacade';
import type {
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export interface TeamProvisioningOpenCodeAggregatePrimaryMemberRestartPorts {
  restartMember(teamName: string, memberName: string): Promise<void>;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  isRunCurrent(run: ProvisioningRun): boolean;
  clearCancelledRestartState(teamName: string, runId: string): Promise<void>;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  getRunLeadName(run: ProvisioningRun): string;
  getRuntimeOwner(teamName: string): OpenCodeAggregatePrimaryRuntimeOwner | undefined;
  stopRuntimeAdapterTeam(teamName: string, runId: string): Promise<void>;
  setAliveRunId(teamName: string, runId: string): void;
  deleteAliveRunId(teamName: string): void;
  persistRestartSystemMessage(input: OpenCodeMemberRestartSystemMessageInput): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  resetRuntimeToolActivity(run: ProvisioningRun, memberName: string): void;
  clearMemberSpawnToolTracking(run: ProvisioningRun, memberName: string): void;
  launchPrimaryLane(input: {
    run: ProvisioningRun;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    assertStillCurrentAfterPersistence?: () => void;
  }): Promise<TeamRuntimeLaunchResult | null>;
  stopUnretainablePrimaryLane(input: {
    adapter: TeamLaunchRuntimeAdapter;
    run: ProvisioningRun;
    previousEffectiveMembers: TeamCreateRequest['members'];
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<void>;
  clearPrimaryStopAfterRelaunch(teamName: string, runId: string): void;
  stopFailedRelaunchCandidate(input: {
    adapter: TeamLaunchRuntimeAdapter;
    run: ProvisioningRun;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    previousOwner: OpenCodeAggregatePrimaryRuntimeOwner | undefined;
  }): Promise<void>;
  persistLaunchStateSnapshot(
    run: ProvisioningRun,
    phase: PersistedTeamLaunchPhase
  ): Promise<unknown>;
  getMixedSecondaryLaunchPhase(run: ProvisioningRun): PersistedTeamLaunchPhase;
  setRuntimeAdapterProgress(
    progress: TeamProvisioningProgress,
    onProgress?: (progress: TeamProvisioningProgress) => void
  ): TeamProvisioningProgress;
  stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void>;
  clearPersistedLaunchState(teamName: string, options: { expectedRunId: string }): Promise<void>;
  clearPrimaryLaneIfOwned(teamName: string, runId: string): Promise<void>;
  getRun(runId: string): ProvisioningRun | undefined;
  cleanupRun(run: ProvisioningRun): void;
  launchSingleMixedSecondaryLane(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void>;
  isTeamAlive(teamName: string): boolean;
}

export interface RestartPureOpenCodeAggregatePrimaryMemberInput {
  teamName: string;
  memberName: string;
  run: ProvisioningRun;
  restartLease: OpenCodeAggregatePrimaryRestartLease;
}

export async function restartPureOpenCodeAggregatePrimaryMember(
  input: RestartPureOpenCodeAggregatePrimaryMemberInput,
  ports: TeamProvisioningOpenCodeAggregatePrimaryMemberRestartPorts
): Promise<void> {
  const { teamName, memberName, run, restartLease } = input;
  const normalizedMemberName = memberName.trim().toLowerCase();
  const primaryMember = run.effectiveMembers.find(
    (member) => member.name.trim().toLowerCase() === normalizedMemberName
  );
  if (!primaryMember) {
    await ports.restartMember(teamName, memberName);
    return;
  }
  if (run.pendingMemberRestarts.has(memberName)) {
    throw new Error(`Restart for teammate "${memberName}" is already in progress`);
  }
  const adapter = ports.getOpenCodeRuntimeAdapter();
  if (!adapter) {
    throw new Error('OpenCode runtime adapter is not available for member restart.');
  }

  const restartNoLongerCurrent = (): boolean =>
    restartLease.cancelRequested ||
    run.processKilled ||
    run.cancelRequested ||
    !ports.isRunCurrent(run);
  const assertRestartCurrent = (): void => {
    if (restartNoLongerCurrent()) {
      throw getCancelledAggregateRestartError(teamName, memberName);
    }
  };
  const assertRestartCurrentAfterPersistence = async (): Promise<void> => {
    if (restartNoLongerCurrent()) {
      await ports.clearCancelledRestartState(teamName, run.runId);
    }
    assertRestartCurrent();
  };

  const previousLaunchState = await ports.readLaunchState(teamName);
  assertRestartCurrent();
  const previousEffectiveMembers = [...run.effectiveMembers];
  const previousExpectedMembers = [...run.expectedMembers];
  const previousSecondaryLanes = [...run.mixedSecondaryLanes];
  const leadMemberName = ports.getRunLeadName(run).trim().toLowerCase();
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

  const currentPrimaryRun = ports.getRuntimeOwner(teamName);
  const assertPrimaryRuntimeOwnerCurrent = (): void => {
    if (
      currentPrimaryRun?.providerId !== 'opencode' ||
      currentPrimaryRun.runId !== run.runId ||
      ports.getRuntimeOwner(teamName) !== currentPrimaryRun
    ) {
      throw getCancelledAggregateRestartError(teamName, memberName);
    }
  };
  assertPrimaryRuntimeOwnerCurrent();
  const localModelPreflight = await adapter.preflightLocalModels?.({
    ...(run.request.allowExperimentalLocalModels === true
      ? { allowExperimentalLocalModels: true }
      : {}),
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
    await ports.stopRuntimeAdapterTeam(teamName, run.runId);
    assertRestartCurrent();
    ports.setAliveRunId(teamName, run.runId);
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
  ports.persistRestartSystemMessage({
    teamName,
    leadName: ports.getRunLeadName(run),
    leadSessionId: run.detectedSessionId?.trim() || run.runId,
    displayName: run.request.displayName?.trim() || run.teamName,
    member: primaryMember,
    reason: 'manual_restart',
    assertStillCurrent: assertRestartCurrent,
  });
  ports.invalidateRuntimeSnapshotCaches(teamName);
  ports.resetRuntimeToolActivity(run, memberName);
  ports.clearMemberSpawnToolTracking(run, memberName);

  let primaryRelaunchResult: TeamRuntimeLaunchResult | null;
  try {
    primaryRelaunchResult = await ports.launchPrimaryLane({
      run,
      adapter,
      prompt: '',
      previousLaunchState,
      assertStillCurrentAfterPersistence: assertRestartCurrent,
    });
    if (restartNoLongerCurrent()) {
      await ports.stopUnretainablePrimaryLane({
        adapter,
        run,
        previousEffectiveMembers,
        previousLaunchState,
      });
      await ports.clearCancelledRestartState(teamName, run.runId);
      throw getCancelledAggregateLaunchError(teamName);
    }
    if (!hasRetainablePrimaryLead(primaryRelaunchResult)) {
      throw new Error('OpenCode primary member restart did not retain the team lead runtime.');
    }
    ports.clearPrimaryStopAfterRelaunch(teamName, run.runId);
  } catch (restartError) {
    if (restartNoLongerCurrent()) {
      const abortedByOwnershipGuard = getErrorMessage(restartError).includes(
        'owning run is no longer active'
      );
      const cleanupUnconfirmed = restartError instanceof OpenCodeAggregateRuntimeStopError;
      if (!abortedByOwnershipGuard && !cleanupUnconfirmed) {
        await ports.stopUnretainablePrimaryLane({
          adapter,
          run,
          previousEffectiveMembers,
          previousLaunchState,
        });
      }
      if (!cleanupUnconfirmed) {
        await ports.clearCancelledRestartState(teamName, run.runId);
      }
      throw abortedByOwnershipGuard || cleanupUnconfirmed
        ? restartError
        : getCancelledAggregateLaunchError(teamName);
    }
    try {
      await ports.stopFailedRelaunchCandidate({
        adapter,
        run,
        previousLaunchState,
        previousOwner: currentPrimaryRun,
      });
    } catch (cleanupError) {
      run.effectiveMembers = previousEffectiveMembers;
      run.expectedMembers = previousExpectedMembers;
      run.mixedSecondaryLanes = previousSecondaryLanes;
      ports.invalidateRuntimeSnapshotCaches(teamName);
      throw new Error(
        `OpenCode member restart failed: ${getErrorMessage(restartError)}. Failed primary candidate cleanup prevented rollback: ${getErrorMessage(cleanupError)}`
      );
    }
    run.effectiveMembers = previousEffectiveMembers;
    run.expectedMembers = previousExpectedMembers;
    run.mixedSecondaryLanes = previousSecondaryLanes;
    ports.invalidateRuntimeSnapshotCaches(teamName);

    try {
      const rollbackResult = await ports.launchPrimaryLane({
        run,
        adapter,
        prompt: '',
        previousLaunchState,
        assertStillCurrentAfterPersistence: assertRestartCurrent,
      });
      if (restartNoLongerCurrent()) {
        await ports.clearCancelledRestartState(teamName, run.runId);
        throw getCancelledAggregateLaunchError(teamName);
      }
      if (!hasRetainablePrimaryLead(rollbackResult)) {
        throw new Error('Primary rollback did not restore a retainable OpenCode team lead.');
      }
      ports.clearPrimaryStopAfterRelaunch(teamName, run.runId);
      await ports.persistLaunchStateSnapshot(run, ports.getMixedSecondaryLaunchPhase(run));
      await assertRestartCurrentAfterPersistence();
      ports.setAliveRunId(teamName, run.runId);
      run.progress = ports.setRuntimeAdapterProgress(
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
        await ports.stopUnretainablePrimaryLane({
          adapter,
          run,
          previousEffectiveMembers,
          previousLaunchState,
        });
        await ports.clearCancelledRestartState(teamName, run.runId);
        throw rollbackError;
      }
      const restartMessage = getErrorMessage(restartError);
      const rollbackMessage = getErrorMessage(rollbackError);
      await ports.stopUnretainablePrimaryLane({
        adapter,
        run,
        previousEffectiveMembers,
        previousLaunchState,
      });
      await ports.stopMixedSecondaryRuntimeLanes(teamName);
      await ports
        .clearPersistedLaunchState(teamName, { expectedRunId: run.runId })
        .catch((error: unknown) => {
          logger.warn(
            `[${teamName}] Failed to clear stale launch state after primary rollback failure: ${getErrorMessage(error)}`
          );
        });
      await ports.clearPrimaryLaneIfOwned(teamName, run.runId);
      run.processKilled = true;
      run.progress = ports.setRuntimeAdapterProgress(
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
      if (ports.getRun(run.runId) === run) {
        ports.cleanupRun(run);
      }
      throw new Error(
        `OpenCode member restart failed: ${restartMessage}. Primary rollback failed: ${rollbackMessage}`
      );
    }
    throw restartError;
  }

  await ports.launchSingleMixedSecondaryLane(run, lane);
  await assertRestartCurrentAfterPersistence();
  await ports.persistLaunchStateSnapshot(run, ports.getMixedSecondaryLaunchPhase(run));
  await assertRestartCurrentAfterPersistence();
  if (ports.isTeamAlive(teamName)) {
    const memberRestartRetained =
      lane.result != null && hasRetainableOpenCodeRuntimeMember(lane.result);
    const restartRetained =
      memberRestartRetained && hasRetainablePrimaryLead(primaryRelaunchResult);
    run.progress = ports.setRuntimeAdapterProgress(
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
    ports.deleteAliveRunId(teamName);
  }
}
