import { randomUUID } from 'crypto';

import { getCancelledAggregateLaunchError } from './OpenCodeAggregatePrimaryRestartPolicy';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';
import { isRecoverableOpenCodeRuntimeEvidence } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { TeamRuntimeLaunchResult } from '../runtime/TeamRuntimeAdapter';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
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
  const runId = randomUUID();
  ports.runs.delete(previousRunId);
  run.runId = runId;
  run.detectedSessionId = null;
  for (const member of run.effectiveMembers) {
    run.memberSpawnStatuses.set(member.name, createInitialMemberSpawnStatusEntry());
  }
  run.progress = { ...run.progress, runId, state: 'disconnected' };
  lease.candidateRunId = runId;
  ports.runs.set(runId, run);
  ports.provisioningRunByTeam.set(run.teamName, runId);
  ports.setAliveRunId(run.teamName, runId);
}

/** Preserve the aggregate owner when a failed primary leaves owned secondary lanes. */
export function retainSecondaryAggregateOwnership(
  run: Pick<ProvisioningRun, 'teamName' | 'runId'>,
  lease: OpenCodeAggregatePrimaryRestartLease,
  ports: {
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
    lease.teamName === run.teamName &&
    ports.getRestartLease() === lease &&
    !lease.cancelRequested &&
    (lease.candidateRunId ?? lease.runId) === run.runId &&
    (!trackedRunId || trackedRunId === run.runId) &&
    !ports.getRuntimeOwner(run.teamName) &&
    (!aliveRunId || aliveRunId === run.runId)
  ) {
    ports.setAliveRunId(run.teamName, run.runId);
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
