import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { TeamProviderId } from '@shared/types';

/** Reads ownership only; admission and runtime state stay with their existing owners. */
export function hasLiveOpenCodeMcpConsumers(input: {
  pendingLaunchAdmissions: number;
  runtimeAdapterRuns: Iterable<{ readonly providerId: TeamProviderId }>;
  secondaryRuntimeLanes: Iterable<{ readonly size: number }>;
  runs: Iterable<
    Readonly<
      Pick<
        ProvisioningRun,
        | 'runId'
        | 'teamName'
        | 'processKilled'
        | 'cancelRequested'
        | 'request'
        | 'allEffectiveMembers'
        | 'mixedSecondaryLanes'
      >
    >
  >;
  provisioningRunByTeam: ReadonlyMap<string, string>;
  getAliveRunId(teamName: string): string | null;
}): boolean {
  // Metadata/provider selection may still be unresolved before a run is registered.
  if (input.pendingLaunchAdmissions > 0) return true;
  if ([...input.runtimeAdapterRuns].some((run) => run.providerId === 'opencode')) {
    return true;
  }
  if ([...input.secondaryRuntimeLanes].some((lanes) => lanes.size > 0)) {
    return true;
  }
  for (const run of input.runs) {
    if (run.processKilled || run.cancelRequested) continue;
    const pending = input.provisioningRunByTeam.get(run.teamName) === run.runId;
    if (!pending && input.getAliveRunId(run.teamName) !== run.runId) continue;
    if (run.request.providerId === 'opencode') return true;
    if (pending && run.allEffectiveMembers.some((member) => member.providerId === 'opencode')) {
      return true;
    }
    if (
      run.mixedSecondaryLanes.some((lane) => !lane.blockedBeforeLaunch && lane.state !== 'finished')
    ) {
      return true;
    }
  }
  return false;
}
