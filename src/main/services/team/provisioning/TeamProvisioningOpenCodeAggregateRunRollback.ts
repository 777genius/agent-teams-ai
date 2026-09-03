import type { TeamLaunchRuntimeAdapter } from '../runtime';
import type {
  OpenCodeAggregateProvisioningRun,
  OpenCodeAggregateRuntimeRunEntry,
  OpenCodeWorktreeRootAggregateLaunchPorts,
} from './TeamProvisioningOpenCodeAggregateRunModel';
import type {
  MixedSecondaryRuntimeLaneState,
  SecondaryRuntimeRunEntry,
} from './TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

function describeAggregateRollbackCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function stopAndRollbackOpenCodeAggregateRuntimeLanes(
  run: OpenCodeAggregateProvisioningRun,
  input: {
    adapter: TeamLaunchRuntimeAdapter;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    primaryCwd: string;
    secondaryCwds: ReadonlyMap<string, string>;
    untrackedPrimaryLaunchMayBeRunning: boolean;
  },
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): Promise<boolean> {
  let rollbackComplete = true;
  let primaryCleanupConfirmed = run.effectiveMembers.length === 0;
  let primaryStorageCleanupRequired = false;
  let exactPrimaryStopOwner:
    | (OpenCodeAggregateRuntimeRunEntry & { providerId: 'opencode' })
    | undefined;
  const ownedRuntimeRun = ports.getRuntimeAdapterRun(run.teamName);
  if (
    input.untrackedPrimaryLaunchMayBeRunning &&
    ownedRuntimeRun === undefined &&
    ports.getProvisioningRun(run.teamName) === run.runId
  ) {
    exactPrimaryStopOwner = {
      runId: run.runId,
      providerId: 'opencode',
      cwd: input.primaryCwd,
      ...(run.request.allowExperimentalLocalModels === true
        ? { allowExperimentalLocalModels: true }
        : {}),
    };
    ports.setRuntimeAdapterRun(run.teamName, exactPrimaryStopOwner);
  } else if (ownedRuntimeRun?.providerId === 'opencode' && ownedRuntimeRun.runId === run.runId) {
    exactPrimaryStopOwner = ownedRuntimeRun as OpenCodeAggregateRuntimeRunEntry & {
      providerId: 'opencode';
    };
  }
  publishOpenCodeAggregateRollbackPendingStop(run, ports);

  if (ownedRuntimeRun?.providerId === 'opencode' && ownedRuntimeRun.runId === run.runId) {
    try {
      await ports.stopOpenCodeRuntimeAdapterTeam(run.teamName, run.runId);
      primaryCleanupConfirmed = true;
    } catch (error) {
      rollbackComplete = false;
      ports.logError(
        `[${run.teamName}] OpenCode aggregate rollback could not stop the tracked primary lane (run ${run.runId}): ${describeAggregateRollbackCause(error)}`
      );
    }
  } else if (input.untrackedPrimaryLaunchMayBeRunning) {
    try {
      const stopResult = await input.adapter.stop({
        runId: run.runId,
        teamName: run.teamName,
        laneId: 'primary',
        cwd: input.primaryCwd,
        providerId: 'opencode',
        reason: 'cleanup',
        force: true,
        previousLaunchState: input.previousLaunchState,
      });
      assertAggregateRuntimeStopConfirmed(stopResult, 'OpenCode aggregate primary lane');
      primaryCleanupConfirmed = true;
      primaryStorageCleanupRequired = true;
    } catch (error) {
      rollbackComplete = false;
      ports.logError(
        `[${run.teamName}] OpenCode aggregate rollback could not stop the untracked primary lane (run ${run.runId}, cwd ${input.primaryCwd}): ${describeAggregateRollbackCause(error)}`
      );
      retainUntrackedOpenCodePrimaryLaneForCleanup(run, input.primaryCwd, ports);
    }
  } else {
    primaryCleanupConfirmed = true;
  }

  // Secondary lanes are stopped one-by-one by exact lane/run identity. A
  // team-scoped stop here could tear down a newer sibling that took ownership
  // while the old aggregate launch was awaiting cancellation.
  for (const lane of run.mixedSecondaryLanes) {
    const laneRunId = lane.runId;
    if (!laneRunId) {
      continue;
    }
    const ownedLane = ports.getSecondaryRuntimeRun(run.teamName, lane.laneId);
    const launchWasSkipped = wasOpenCodeLaneBlockedBeforeLaunch(lane);
    let laneCleanupConfirmed = launchWasSkipped;
    let exactLaneStopOwner: SecondaryRuntimeRunEntry | undefined;
    if (ownedLane?.providerId === 'opencode' && ownedLane.runId === laneRunId) {
      exactLaneStopOwner = ownedLane;
      try {
        const stopResult = await input.adapter.stop({
          runId: ownedLane.runId,
          teamName: run.teamName,
          laneId: lane.laneId,
          cwd: ownedLane.cwd ?? input.secondaryCwds.get(lane.laneId),
          providerId: 'opencode',
          reason: 'cleanup',
          previousLaunchState: input.previousLaunchState,
        });
        assertAggregateRuntimeStopConfirmed(
          stopResult,
          `OpenCode aggregate secondary lane ${lane.laneId}`
        );
        laneCleanupConfirmed = true;
      } catch (error) {
        rollbackComplete = false;
        ports.logError(
          `[${run.teamName}] OpenCode aggregate rollback could not stop tracked secondary lane ${lane.laneId} (run ${laneRunId}): ${describeAggregateRollbackCause(error)}`
        );
        continue;
      }
    } else if (
      ownedLane === undefined &&
      !launchWasSkipped &&
      ports.getProvisioningRun(run.teamName) === run.runId
    ) {
      const registeredLaneStopOwner = {
        teamName: run.teamName,
        runId: laneRunId,
        providerId: 'opencode',
        laneId: lane.laneId,
        memberName: lane.member.name,
        cwd: input.secondaryCwds.get(lane.laneId),
      } satisfies SecondaryRuntimeRunEntry & { teamName: string };
      ports.setSecondaryRuntimeRun(registeredLaneStopOwner);
      exactLaneStopOwner =
        ports.getSecondaryRuntimeRun(run.teamName, lane.laneId) ?? registeredLaneStopOwner;
      try {
        const stopResult = await input.adapter.stop({
          runId: laneRunId,
          teamName: run.teamName,
          laneId: lane.laneId,
          cwd: input.secondaryCwds.get(lane.laneId),
          providerId: 'opencode',
          reason: 'cleanup',
          previousLaunchState: input.previousLaunchState,
        });
        assertAggregateRuntimeStopConfirmed(
          stopResult,
          `OpenCode aggregate secondary lane ${lane.laneId}`
        );
        laneCleanupConfirmed = true;
      } catch (error) {
        rollbackComplete = false;
        ports.logError(
          `[${run.teamName}] OpenCode aggregate rollback could not stop untracked secondary lane ${lane.laneId} (run ${laneRunId}): ${describeAggregateRollbackCause(error)}`
        );
        continue;
      }
    }

    if (!laneCleanupConfirmed) {
      continue;
    }

    const currentLane = ports.getSecondaryRuntimeRun(run.teamName, lane.laneId);
    const laneStillOwned =
      exactLaneStopOwner !== undefined
        ? currentLane === exactLaneStopOwner
        : currentLane?.providerId === 'opencode' && currentLane.runId === lane.runId;
    const teamStillOwned = ports.getProvisioningRun(run.teamName) === run.runId;
    if (!laneStillOwned && !(currentLane === undefined && teamStillOwned)) {
      continue;
    }
    let storageCleared = false;
    try {
      storageCleared = await ports.clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.getTeamsBasePath(),
        teamName: run.teamName,
        laneId: lane.laneId,
        expectedRunId: laneRunId,
      });
    } catch (error) {
      rollbackComplete = false;
      ports.logError(
        `[${run.teamName}] OpenCode aggregate rollback could not clear storage for secondary lane ${lane.laneId} (run ${laneRunId}): ${describeAggregateRollbackCause(error)}`
      );
      retainUntrackedOpenCodeSecondaryLaneForCleanup(run, lane, laneRunId, input, ports);
      continue;
    }
    if (!storageCleared) {
      const laneAfterFailedClear = ports.getSecondaryRuntimeRun(run.teamName, lane.laneId);
      const targetStillOwnsLane =
        laneAfterFailedClear?.providerId === 'opencode' && laneAfterFailedClear.runId === laneRunId;
      const targetStillOwnsUntrackedLane =
        laneAfterFailedClear === undefined && ports.getProvisioningRun(run.teamName) === run.runId;
      if (targetStillOwnsLane || (targetStillOwnsUntrackedLane && !launchWasSkipped)) {
        rollbackComplete = false;
        retainUntrackedOpenCodeSecondaryLaneForCleanup(run, lane, laneRunId, input, ports);
      }
      continue;
    }
    const laneAfterStorageClear = ports.getSecondaryRuntimeRun(run.teamName, lane.laneId);
    if (
      exactLaneStopOwner !== undefined
        ? laneAfterStorageClear === exactLaneStopOwner
        : laneAfterStorageClear?.providerId === 'opencode' &&
          laneAfterStorageClear.runId === lane.runId
    ) {
      ports.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
    }
  }

  const currentRuntimeRun = ports.getRuntimeAdapterRun(run.teamName);
  const primaryStillOwned =
    exactPrimaryStopOwner !== undefined
      ? currentRuntimeRun === exactPrimaryStopOwner
      : currentRuntimeRun?.providerId === 'opencode' && currentRuntimeRun.runId === run.runId;
  const teamStillOwned = ports.getProvisioningRun(run.teamName) === run.runId;
  if (
    primaryCleanupConfirmed &&
    primaryStorageCleanupRequired &&
    run.effectiveMembers.length > 0 &&
    (primaryStillOwned || (currentRuntimeRun === undefined && teamStillOwned))
  ) {
    let primaryStorageCleared = false;
    try {
      primaryStorageCleared = await ports.clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.getTeamsBasePath(),
        teamName: run.teamName,
        laneId: 'primary',
        expectedRunId: run.runId,
      });
    } catch (error) {
      rollbackComplete = false;
      ports.logError(
        `[${run.teamName}] OpenCode aggregate rollback could not clear storage for the primary lane (run ${run.runId}): ${describeAggregateRollbackCause(error)}`
      );
      retainUntrackedOpenCodePrimaryLaneForCleanup(run, input.primaryCwd, ports);
    }
    if (!primaryStorageCleared) {
      const ownerAfterFailedClear = ports.getRuntimeAdapterRun(run.teamName);
      const targetStillOwnsPrimary =
        ownerAfterFailedClear?.providerId === 'opencode' &&
        ownerAfterFailedClear.runId === run.runId;
      const targetStillOwnsUntrackedPrimary =
        ownerAfterFailedClear === undefined && ports.getProvisioningRun(run.teamName) === run.runId;
      if (targetStillOwnsPrimary || targetStillOwnsUntrackedPrimary) {
        rollbackComplete = false;
        retainUntrackedOpenCodePrimaryLaneForCleanup(run, input.primaryCwd, ports);
      }
    }
  }
  if (!rollbackComplete) {
    publishOpenCodeAggregateRollbackFailed(run, ports);
  }
  return rollbackComplete;
}

function publishOpenCodeAggregateRollbackPendingStop(
  run: OpenCodeAggregateProvisioningRun,
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): void {
  run.progress = ports.setRuntimeAdapterProgress(
    {
      ...run.progress,
      state: 'disconnected',
      message: 'Stopping OpenCode runtime lanes for launch rollback',
      updatedAt: ports.nowIso(),
    },
    run.onProgress
  );
  ports.invalidateRuntimeSnapshotCaches(run.teamName);
}

function publishOpenCodeAggregateRollbackFailed(
  run: OpenCodeAggregateProvisioningRun,
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): void {
  run.progress = ports.setRuntimeAdapterProgress(
    {
      ...run.progress,
      state: 'failed',
      message: 'OpenCode runtime lane rollback could not confirm every stop',
      messageSeverity: 'error',
      updatedAt: ports.nowIso(),
    },
    run.onProgress
  );
  ports.invalidateRuntimeSnapshotCaches(run.teamName);
}

function wasOpenCodeLaneBlockedBeforeLaunch(lane: MixedSecondaryRuntimeLaneState): boolean {
  return lane.diagnostics.some((diagnostic) =>
    diagnostic.includes('This lane was not attempted because it uses the same project runtime.')
  );
}

function retainUntrackedOpenCodeSecondaryLaneForCleanup(
  run: OpenCodeAggregateProvisioningRun,
  lane: MixedSecondaryRuntimeLaneState,
  laneRunId: string,
  input: { secondaryCwds: ReadonlyMap<string, string> },
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): void {
  if (
    ports.getSecondaryRuntimeRun(run.teamName, lane.laneId) === undefined &&
    ports.getProvisioningRun(run.teamName) === run.runId
  ) {
    ports.setSecondaryRuntimeRun({
      teamName: run.teamName,
      runId: laneRunId,
      providerId: 'opencode',
      laneId: lane.laneId,
      memberName: lane.member.name,
      cwd: input.secondaryCwds.get(lane.laneId),
    });
  }
}

function retainUntrackedOpenCodePrimaryLaneForCleanup(
  run: OpenCodeAggregateProvisioningRun,
  primaryCwd: string,
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): void {
  if (
    ports.getRuntimeAdapterRun(run.teamName) === undefined &&
    ports.getProvisioningRun(run.teamName) === run.runId
  ) {
    ports.setRuntimeAdapterRun(run.teamName, {
      runId: run.runId,
      providerId: 'opencode',
      cwd: primaryCwd,
      ...(run.request.allowExperimentalLocalModels === true
        ? { allowExperimentalLocalModels: true }
        : {}),
    });
  }
}

function assertAggregateRuntimeStopConfirmed(
  result: { stopped: boolean; diagnostics: string[]; warnings: string[] },
  label: string
): void {
  if (result.stopped) {
    return;
  }
  const detail = [...result.diagnostics, ...result.warnings]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join('; ');
  throw new Error(
    detail ? `${label} did not confirm stop: ${detail}` : `${label} did not confirm stop`
  );
}

export function deleteOpenCodeAggregateRuntimeTrackingIfOwned(
  teamName: string,
  runId: string,
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): void {
  const currentRuntimeRun = ports.getRuntimeAdapterRun(teamName);
  const hasConflictingRuntimeOwner =
    currentRuntimeRun !== undefined &&
    (currentRuntimeRun.providerId !== 'opencode' || currentRuntimeRun.runId !== runId);
  if (hasConflictingRuntimeOwner) {
    return;
  }

  ports.deleteRuntimeAdapterRun(teamName);
  if (ports.getProvisioningRun(teamName) === runId) {
    ports.deleteAliveRunId(teamName);
  }
}
