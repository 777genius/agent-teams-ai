import { randomUUID } from 'crypto';

import type { TeamRuntimeLaunchResult } from '../runtime/TeamRuntimeAdapter';
import { getCancelledAggregateLaunchError } from './OpenCodeAggregatePrimaryRestartPolicy';
import { OpenCodeRetainedPrimaryRestartError } from './OpenCodeRetainedPrimaryRestartError';
import type { OpenCodeRetainedSecondaryDelivery } from './OpenCodeRetainedSecondaryOwnership';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';
import { isRecoverableOpenCodeRuntimeEvidence } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { SecondaryRuntimeRunEntry } from './TeamProvisioningSecondaryRuntimeRuns';
import type { OpenCodeAggregatePrimaryRestartLease } from './TeamProvisioningServiceMemberLifecycleFacade';

/** Synchronous handoff after a confirmed primary stop; secondary lanes keep their identities. */
export function advanceOpenCodePrimaryIncarnation(
  run: ProvisioningRun,
  lease: OpenCodeAggregatePrimaryRestartLease,
  ports: {
    runs: Map<string, ProvisioningRun>;
    provisioningRunByTeam: Map<string, string>;
    getRuntimeOwner(teamName: string): unknown;
    getAliveRunId(teamName: string): string | null;
    setAliveRunId(teamName: string, runId: string): void;
  }
): void {
  const previousRunId = run.runId;
  const tracked = ports.provisioningRunByTeam.get(run.teamName);
  const alive = ports.getAliveRunId(run.teamName);
  if (
    lease.cancelRequested ||
    lease.teamName !== run.teamName ||
    (lease.candidateRunId ?? lease.runId) !== previousRunId ||
    run.cancelRequested ||
    run.processKilled ||
    ports.runs.get(previousRunId) !== run ||
    ports.getRuntimeOwner(run.teamName) ||
    (tracked && tracked !== previousRunId) ||
    (alive && alive !== previousRunId)
  ) {
    throw getCancelledAggregateLaunchError(run.teamName);
  }
  delete run.retainedSecondaryDelivery;
  const runId = randomUUID();
  ports.runs.delete(previousRunId);
  run.runId = runId;
  run.detectedSessionId = null;
  for (const member of run.effectiveMembers) {
    run.memberSpawnStatuses.set(member.name, createInitialMemberSpawnStatusEntry());
  }
  run.progress = {
    ...run.progress,
    runId,
    state: 'disconnected',
    retainedSecondaryRuntime: undefined,
  };
  lease.candidateRunId = runId;
  ports.runs.set(runId, run);
  ports.provisioningRunByTeam.set(run.teamName, runId);
  ports.setAliveRunId(run.teamName, runId);
}

/** Preserve the aggregate owner when a failed primary leaves owned secondary lanes. */
export function retainSecondaryAggregateOwnership(
  run: Pick<
    ProvisioningRun,
    'teamName' | 'runId' | 'retainedSecondaryDelivery' | 'processKilled' | 'cancelRequested'
  >,
  lease: OpenCodeAggregatePrimaryRestartLease,
  ports: {
    captureRetainedSecondaryDelivery?(): OpenCodeRetainedSecondaryDelivery | null;
    mayRestore(): boolean;
    getRestartLease(): OpenCodeAggregatePrimaryRestartLease | undefined;
    getTrackedRunId(): string | null;
    getRuntimeOwner(teamName: string): unknown;
    getAliveRunId(teamName: string): string | null;
    setAliveRunId(teamName: string, runId: string): void;
  }
): void {
  const aliveRunId = ports.getAliveRunId(run.teamName);
  const trackedRunId = ports.getTrackedRunId();
  if (
    ports.mayRestore() &&
    !run.processKilled &&
    !run.cancelRequested &&
    lease.teamName === run.teamName &&
    ports.getRestartLease() === lease &&
    !lease.cancelRequested &&
    (lease.candidateRunId ?? lease.runId) === run.runId &&
    (!trackedRunId || trackedRunId === run.runId) &&
    !ports.getRuntimeOwner(run.teamName) &&
    (!aliveRunId || aliveRunId === run.runId)
  ) {
    ports.setAliveRunId(run.teamName, run.runId);
    const fact = ports.captureRetainedSecondaryDelivery?.();
    if (fact?.ownerRunId === run.runId) run.retainedSecondaryDelivery = fact;
  }
}

export function hasRetainablePrimaryLead(
  result: TeamRuntimeLaunchResult | null,
  leadName: string
): boolean {
  if (!result) return false;
  const leadEvidence = Object.entries(result.members).find(
    ([name, evidence]) => (evidence.memberName?.trim() || name.trim()).toLowerCase() === leadName
  )?.[1];
  return Boolean(
    leadEvidence &&
    leadEvidence.launchState !== 'failed_to_start' &&
    leadEvidence.hardFailure !== true &&
    isRecoverableOpenCodeRuntimeEvidence(leadEvidence)
  );
}

export function captureRetainedSecondaryDelivery(
  run: Pick<ProvisioningRun, 'runId' | 'mixedSecondaryLanes'>,
  owners: ReadonlyMap<string, SecondaryRuntimeRunEntry> | undefined,
  stopAllTeamsGeneration: number,
  stopTeamGeneration: number
): OpenCodeRetainedSecondaryDelivery | null {
  const lanes = run.mixedSecondaryLanes.flatMap((lane) => {
    const owner = owners?.get(lane.laneId);
    return owner && owner.runId === lane.runId && owner.memberName === lane.member.name
      ? [{ laneId: owner.laneId, runId: owner.runId, memberName: owner.memberName }]
      : [];
  });
  return lanes.length
    ? { ownerRunId: run.runId, stopAllTeamsGeneration, stopTeamGeneration, lanes }
    : null;
}

export function createAggregatePrimaryRestartFailure(
  run: Pick<
    ProvisioningRun,
    'teamName' | 'runId' | 'processKilled' | 'cancelRequested' | 'retainedSecondaryDelivery'
  >,
  lease: OpenCodeAggregatePrimaryRestartLease,
  ports: Parameters<typeof retainSecondaryAggregateOwnership>[2],
  message: string
): Error {
  const fact = run.retainedSecondaryDelivery;
  if (
    fact &&
    ports.mayRestore() &&
    !run.cancelRequested &&
    !run.processKilled &&
    ports.getRestartLease() === lease &&
    !lease.cancelRequested &&
    lease.teamName === run.teamName &&
    (lease.candidateRunId ?? lease.runId) === run.runId &&
    ports.getAliveRunId(run.teamName) === run.runId &&
    (!ports.getTrackedRunId() || ports.getTrackedRunId() === run.runId) &&
    !ports.getRuntimeOwner(run.teamName) &&
    JSON.stringify(ports.captureRetainedSecondaryDelivery?.()) === JSON.stringify(fact)
  ) {
    return new OpenCodeRetainedPrimaryRestartError(message, {
      teamName: run.teamName,
      memberName: lease.memberName,
      predecessorRunId: lease.runId,
      successorRunId: run.runId,
    });
  }
  return new Error(message);
}

export function isAggregateRuntimeOwnerAlive(input: {
  runId: string | null;
  hasPrimaryRuntime: boolean;
  hasSecondaryRuntime: boolean;
  runtimeProgressState: ProvisioningRun['progress']['state'] | undefined;
  run: Pick<ProvisioningRun, 'processKilled' | 'cancelRequested' | 'child'> | undefined;
}): boolean {
  if (!input.runId) return false;
  if (
    !input.hasSecondaryRuntime &&
    ['disconnected', 'failed', 'cancelled'].includes(input.runtimeProgressState ?? '')
  )
    return false;
  if (!input.run) return input.hasPrimaryRuntime || input.hasSecondaryRuntime;
  return (
    (input.hasPrimaryRuntime || input.hasSecondaryRuntime || input.run.child != null) &&
    !input.run.processKilled &&
    !input.run.cancelRequested
  );
}
