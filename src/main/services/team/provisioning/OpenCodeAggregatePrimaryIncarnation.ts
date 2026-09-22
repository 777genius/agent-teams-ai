import { randomUUID } from 'crypto';

import { getCancelledAggregateLaunchError } from './OpenCodeAggregatePrimaryRestartPolicy';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';

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
