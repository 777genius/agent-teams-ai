import type { TeamLaunchRuntimeAdapter, TeamRuntimeLaunchResult } from '../runtime';
import type { OpenCodeAggregatePrimaryLaneStopPorts } from './OpenCodeAggregatePrimaryLaneStopHelpers';
import type {
  OpenCodeAggregatePrimaryProgressPublisher,
  OpenCodeAggregatePrimaryProgressPublisherPorts,
} from './OpenCodeAggregatePrimaryProgressPublisher';
import type {
  OpenCodePrimaryLaneRebootstrapPorts,
  OpenCodePrimaryLaneRebootstrapRun,
} from './TeamProvisioningOpenCodePrimaryLaneRebootstrap';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { RuntimeAdapterRunByTeamEntry } from './TeamProvisioningServiceComposition';
import type { PersistedTeamLaunchPhase, TeamCreateRequest } from '@shared/types';

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
 * The extra facade state the delivery-triggered lead re-bootstrap reaches.
 *
 * It is a separate interface because it is a strictly larger surface than the
 * stop helpers need: every gate the re-bootstrap consults (manual restart,
 * primary stop, stop generations, the stop marker) is facade state that the
 * ordinary launch path never has to read.
 */
export interface OpenCodePrimaryLaneRebootstrapWiringHost {
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  resolveActiveRun(teamName: string): ProvisioningRun | null;
  hasManualRestartInFlight(teamName: string): boolean;
  hasPrimaryStopInFlight(teamName: string): boolean;
  isStopped(teamName: string): Promise<boolean>;
  getStopAllTeamsGeneration(): number;
  getStopTeamGeneration(teamName: string): number;
  canDeliverToOpenCodeRuntime(teamName: string): boolean;
  stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void>;
  setAliveRunId(teamName: string, runId: string): void;
  launchOpenCodeAggregatePrimaryLane(input: {
    run: ProvisioningRun;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
  }): Promise<TeamRuntimeLaunchResult | null>;
  hasCommittedLeadSessionEvidence(input: {
    teamName: string;
    runId: string;
    memberName: string;
  }): Promise<boolean>;
  persistLaunchStateSnapshot(
    run: ProvisioningRun,
    launchPhase: PersistedTeamLaunchPhase
  ): Promise<unknown>;
  getMixedSecondaryLaunchPhase(run: ProvisioningRun): PersistedTeamLaunchPhase;
  beginRebootstrapLease(
    teamName: string,
    memberName: string,
    runId: string
  ): { lease: { cancelRequested?: boolean }; release(): void };
  resolveLeadName(run: ProvisioningRun): string;
  logWarn(message: string): void;
}

/**
 * The re-bootstrap helper describes the run by the fields it actually reads, so
 * the widening back to the facade's own run type happens once, here, instead of
 * as a cast at every call site.
 */
export function createOpenCodePrimaryLaneRebootstrapPorts(
  host: OpenCodePrimaryLaneRebootstrapWiringHost,
  progress: OpenCodeAggregatePrimaryProgressPublisher
): OpenCodePrimaryLaneRebootstrapPorts {
  const asProvisioningRun = (run: OpenCodePrimaryLaneRebootstrapRun): ProvisioningRun =>
    run as ProvisioningRun;
  return {
    getAdapter: () => host.getOpenCodeRuntimeAdapter(),
    resolveActiveRun: (teamName) => host.resolveActiveRun(teamName),
    hasManualRestartInFlight: (teamName) => host.hasManualRestartInFlight(teamName),
    hasPrimaryStopInFlight: (teamName) => host.hasPrimaryStopInFlight(teamName),
    isStopped: (teamName) => host.isStopped(teamName),
    getStopAllTeamsGeneration: () => host.getStopAllTeamsGeneration(),
    getStopTeamGeneration: (teamName) => host.getStopTeamGeneration(teamName),
    canDeliverToOpenCodeRuntime: (teamName) => host.canDeliverToOpenCodeRuntime(teamName),
    stopOpenCodeRuntimeAdapterTeam: (teamName, runId) =>
      host.stopOpenCodeRuntimeAdapterTeam(teamName, runId),
    setAliveRunId: (teamName, runId) => host.setAliveRunId(teamName, runId),
    launchOpenCodeAggregatePrimaryLane: (input) =>
      host.launchOpenCodeAggregatePrimaryLane({
        run: asProvisioningRun(input.run),
        adapter: input.adapter,
        prompt: input.prompt,
      }),
    hasCommittedLeadSessionEvidence: (input) => host.hasCommittedLeadSessionEvidence(input),
    persistLaunchStateSnapshot: (run, launchPhase) =>
      host.persistLaunchStateSnapshot(asProvisioningRun(run), launchPhase),
    getMixedSecondaryLaunchPhase: (run) =>
      host.getMixedSecondaryLaunchPhase(asProvisioningRun(run)),
    beginRebootstrapLease: (teamName, memberName, runId) =>
      host.beginRebootstrapLease(teamName, memberName, runId),
    publishPending: (run, message) => progress.publishPending(asProvisioningRun(run), message),
    publishReady: (run, message) => progress.publishReady(asProvisioningRun(run), message),
    publishFailed: (run, message, error) =>
      progress.publishFailed(asProvisioningRun(run), message, error),
    logWarn: (message) => host.logWarn(message),
    resolveLeadName: (run) => host.resolveLeadName(asProvisioningRun(run)),
  };
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
