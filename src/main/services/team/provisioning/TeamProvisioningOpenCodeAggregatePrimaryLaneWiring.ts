import type { OpenCodeAggregatePrimaryLaneStopPorts } from './OpenCodeAggregatePrimaryLaneStopHelpers';
import type {
  OpenCodeAggregatePrimaryProgressPublisher,
  OpenCodeAggregatePrimaryProgressPublisherPorts,
} from './OpenCodeAggregatePrimaryProgressPublisher';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { RuntimeAdapterRunByTeamEntry } from './TeamProvisioningServiceComposition';
import type { TeamCreateRequest } from '@shared/types';

/**
 * The facade state the aggregate primary lane's helpers are allowed to reach.
 * Declared once, in one place, so every helper the primary lane grows is wired
 * through the same named accessors instead of another ad-hoc closure literal
 * inside an already large facade.
 */
export interface OpenCodeAggregatePrimaryLaneWiringHost extends OpenCodeAggregatePrimaryProgressPublisherPorts {
  getRuntimeOwner(teamName: string): RuntimeAdapterRunByTeamEntry | undefined;
  setRuntimeOwner(teamName: string, owner: RuntimeAdapterRunByTeamEntry): void;
  deleteRuntimeOwner(teamName: string): void;
  getOpenCodeRuntimeLaunchCwd(baseCwd: string, members: TeamCreateRequest['members']): string;
  logWarn(message: string): void;
}

/**
 * Progress is published against one run, so the run is bound here rather than
 * threaded through every stop helper signature.
 */
export function createOpenCodeAggregatePrimaryLaneStopPorts(
  host: OpenCodeAggregatePrimaryLaneWiringHost,
  progress: OpenCodeAggregatePrimaryProgressPublisher,
  run: ProvisioningRun
): OpenCodeAggregatePrimaryLaneStopPorts {
  return {
    getRuntimeOwner: (teamName) => host.getRuntimeOwner(teamName),
    setRuntimeOwner: (teamName, owner) => host.setRuntimeOwner(teamName, owner),
    deleteRuntimeOwner: (teamName) => host.deleteRuntimeOwner(teamName),
    getOpenCodeRuntimeLaunchCwd: (baseCwd, members) =>
      host.getOpenCodeRuntimeLaunchCwd(baseCwd, members),
    publishPending: (message) => progress.publishPending(run, message),
    publishFailed: (message, error) => progress.publishFailed(run, message, error),
    logWarn: (message) => host.logWarn(message),
  };
}
