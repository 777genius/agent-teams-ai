import { clearBootstrapState } from '../TeamBootstrapStateReader';

import type { TeamLaunchStateStore } from '../TeamLaunchStateStore';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { OpenCodeAggregatePrimaryRestartLease } from './TeamProvisioningServiceMemberLifecycleFacade';

interface MemberLifecycleCompletion {
  teamKey: string;
  completion: Promise<void>;
}

export async function waitForAggregateMemberLifecycleOperations(input: {
  teamName: string;
  memberLifecycleCompletions: Iterable<MemberLifecycleCompletion>;
  failedLaneRetries: Iterable<[string, Promise<unknown>]>;
}): Promise<void> {
  const teamKey = input.teamName.trim().toLowerCase();
  const completions = Array.from(input.memberLifecycleCompletions)
    .filter((entry) => entry.teamKey === teamKey)
    .map((entry) => entry.completion);
  const failedLaneRetry = Array.from(input.failedLaneRetries).find(
    ([candidateTeamName]) => candidateTeamName.trim().toLowerCase() === teamKey
  )?.[1];
  if (failedLaneRetry) {
    completions.push(
      failedLaneRetry.then(
        () => undefined,
        () => undefined
      )
    );
  }
  await Promise.all(completions);
}

export function beginAggregatePrimaryRestart(input: {
  teamName: string;
  memberName: string;
  runId: string;
  restarts: Map<string, OpenCodeAggregatePrimaryRestartLease>;
  memberLifecycleCompletions: Map<string, MemberLifecycleCompletion>;
}): { lease: OpenCodeAggregatePrimaryRestartLease; release: () => void } {
  const teamKey = input.teamName.trim().toLowerCase();
  const activeRestart = input.restarts.get(teamKey);
  if (activeRestart) {
    throw new Error(
      `OpenCode aggregate primary restart for teammate "${activeRestart.memberName}" is already in progress for team "${input.teamName}"`
    );
  }

  const memberKey = `${teamKey}\0${input.memberName.trim().toLowerCase()}`;
  const precedingLifecycleOperations = Array.from(input.memberLifecycleCompletions.entries())
    .filter(([operationKey, entry]) => entry.teamKey === teamKey && operationKey !== memberKey)
    .map(([, entry]) => entry.completion);
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const lease: OpenCodeAggregatePrimaryRestartLease = {
    teamName: input.teamName,
    runId: input.runId,
    memberName: input.memberName,
    completion,
    precedingLifecycleOperations,
    cancelRequested: false,
  };
  input.restarts.set(teamKey, lease);
  return {
    lease,
    release: () => {
      resolveCompletion();
      if (input.restarts.get(teamKey) === lease) input.restarts.delete(teamKey);
    },
  };
}

export async function waitForAggregatePrimaryRestart(input: {
  teamName: string;
  currentMemberName?: string;
  restarts: Map<string, OpenCodeAggregatePrimaryRestartLease>;
}): Promise<string | null> {
  const restart = input.restarts.get(input.teamName.trim().toLowerCase());
  if (!restart) return null;
  if (restart.memberName.trim().toLowerCase() === input.currentMemberName?.trim().toLowerCase()) {
    return restart.runId;
  }
  await restart.completion;
  return restart.runId;
}

export function resolveAggregatePrimaryRestartCandidate(input: {
  runtimeRun?: { runId: string; providerId: string };
  run: ProvisioningRun | null;
  memberName: string;
}): { runId: string; run: ProvisioningRun | null } | null {
  if (input.runtimeRun?.providerId !== 'opencode') return null;
  if (!input.run || input.run.processKilled || input.run.cancelRequested) {
    return { runId: input.runtimeRun.runId, run: null };
  }
  const memberName = input.memberName.trim().toLowerCase();
  const hasSecondaryLane = input.run.mixedSecondaryLanes.some(
    (lane) => lane.member.name.trim().toLowerCase() === memberName
  );
  return hasSecondaryLane ? null : { runId: input.run.runId, run: input.run };
}

export function assertAggregatePrimaryStopConfirmed(result: {
  stopped: boolean;
  diagnostics: string[];
  warnings: string[];
}): void {
  if (result.stopped) return;
  const detail = [...result.diagnostics, ...result.warnings]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join('; ');
  throw new Error(
    detail
      ? `OpenCode primary lane did not confirm stop: ${detail}`
      : 'OpenCode primary lane did not confirm stop'
  );
}

export function getCancelledAggregateRestartError(teamName: string, memberName: string): Error {
  return new Error(
    `OpenCode aggregate primary restart for teammate "${memberName}" was cancelled because team "${teamName}" is no longer running`
  );
}

export function assertAggregatePrimaryRestartLeaseCurrent(input: {
  teamName: string;
  memberName: string;
  lease: OpenCodeAggregatePrimaryRestartLease;
  restarts: Map<string, OpenCodeAggregatePrimaryRestartLease>;
}): void {
  if (
    input.restarts.get(input.teamName.trim().toLowerCase()) !== input.lease ||
    input.lease.cancelRequested
  ) {
    throw getCancelledAggregateRestartError(input.teamName, input.memberName);
  }
}

export function createAggregatePrimaryRestartLeaseGuard(
  lease: OpenCodeAggregatePrimaryRestartLease,
  restarts: Map<string, OpenCodeAggregatePrimaryRestartLease>
): () => void {
  return () =>
    assertAggregatePrimaryRestartLeaseCurrent({
      teamName: lease.teamName,
      memberName: lease.memberName,
      lease,
      restarts,
    });
}

export function getCancelledAggregateLaunchError(teamName: string): Error {
  return new Error(
    `OpenCode aggregate primary launch for team "${teamName}" was cancelled because the owning run is no longer active`
  );
}

export async function clearPersistedAggregateLaunchStateIfOwned(input: {
  teamName: string;
  expectedRunId: string;
  confirmedCancelledRestart?: OpenCodeAggregatePrimaryRestartLease;
  getTrackedRunId(teamName: string): string | null | undefined;
  lastWrittenRunIds: Map<string, string>;
  restarts: Map<string, OpenCodeAggregatePrimaryRestartLease>;
  launchStateStore: TeamLaunchStateStore;
  withLaunchStateLock(operation: () => Promise<void>): Promise<void>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
}): Promise<void> {
  await input.withLaunchStateLock(async () => {
    const trackedRunId = input.getTrackedRunId(input.teamName);
    if (trackedRunId && trackedRunId !== input.expectedRunId) return;
    const lastWrittenRunId = input.lastWrittenRunIds.get(input.teamName);
    if (lastWrittenRunId && lastWrittenRunId !== input.expectedRunId) return;
    const cancelledRestart = input.restarts.get(input.teamName.trim().toLowerCase());
    const ownedByCancelledRestart =
      (cancelledRestart?.runId === input.expectedRunId && cancelledRestart.cancelRequested) ||
      (input.confirmedCancelledRestart?.runId === input.expectedRunId &&
        input.confirmedCancelledRestart.cancelRequested);
    const snapshot = await input.launchStateStore.read(input.teamName).catch(() => null);
    const persistedPrimaryRunIds = new Set(
      Object.values(snapshot?.members ?? {})
        .filter((member) => member.laneId === 'primary' || member.laneKind === 'primary')
        .map((member) => member.runtimeRunId?.trim())
        .filter((runId): runId is string => Boolean(runId))
    );
    if (
      lastWrittenRunId !== input.expectedRunId &&
      !ownedByCancelledRestart &&
      (persistedPrimaryRunIds.size !== 1 || !persistedPrimaryRunIds.has(input.expectedRunId))
    ) {
      return;
    }
    await input.launchStateStore.clear(input.teamName);
    input.lastWrittenRunIds.delete(input.teamName);
    await clearBootstrapState(input.teamName);
    input.invalidateRuntimeSnapshotCaches(input.teamName);
  });
}
