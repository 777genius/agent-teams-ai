import type { OpenCodeWorktreeRootAggregateLaunchPreflightPorts } from './TeamProvisioningOpenCodeAggregateRunModel';
import type { TeamLaunchResponse, TeamProvisioningProgress } from '@shared/types';

export async function prepareOpenCodeWorktreeRootAggregateLaunchPreflight(
  input: {
    teamName: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
    stopAllGenerationAtStart?: number;
    stopTeamGenerationAtStart?: number;
  },
  ports: OpenCodeWorktreeRootAggregateLaunchPreflightPorts
): Promise<TeamLaunchResponse | null> {
  const stopAllGenerationAtStart =
    input.stopAllGenerationAtStart ?? ports.getStopAllTeamsGeneration();
  const stopTeamGenerationAtStart =
    input.stopTeamGenerationAtStart ?? ports.getStopTeamGeneration(input.teamName);
  const recordCancellationIfRequested = (): TeamLaunchResponse | null =>
    ports.getStopAllTeamsGeneration() !== stopAllGenerationAtStart ||
    ports.getStopTeamGeneration(input.teamName) !== stopTeamGenerationAtStart
      ? ports.recordCancelledOpenCodeRuntimeAdapterLaunch(
          input.teamName,
          input.sourceWarning,
          input.onProgress
        )
      : null;
  const cancellationBeforeCleanup = recordCancellationIfRequested();
  if (cancellationBeforeCleanup) return cancellationBeforeCleanup;
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
