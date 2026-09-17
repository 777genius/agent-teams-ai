import { shouldCacheMemberSpawnStatusesSnapshot } from './TeamProvisioningMemberSpawnSnapshotCurrency';
import {
  buildMemberSpawnStatusesSnapshotForRun,
  cloneMemberSpawnStatusesSnapshot,
  type MemberSpawnStatusesSnapshotPorts,
  type MemberSpawnStatusRun,
  readPersistedMemberSpawnStatusesSnapshot,
} from './TeamProvisioningMemberSpawnSnapshots';
import { summarizeMemberSpawnStatusRecord } from './TeamProvisioningMemberSpawnStatusPolicy';
import { maybeProjectStoppedCachedSpawnSnapshot } from './TeamProvisioningStoppedTeamSpawnProjection';

import type { MemberSpawnStatusesSnapshot } from '@shared/types';

function overlayStoppedLiveSpawnSnapshot<TRun extends MemberSpawnStatusRun>(
  teamName: string,
  snapshot: MemberSpawnStatusesSnapshot,
  ports: MemberSpawnStatusesSnapshotPorts<TRun>
): Promise<MemberSpawnStatusesSnapshot> {
  return maybeProjectStoppedCachedSpawnSnapshot({
    teamName,
    hasTrackedRun: true,
    snapshot,
    readLaunchFreshness: (candidateTeamName) =>
      ports.persisted.readLaunchFreshness(candidateTeamName),
    summarize: summarizeMemberSpawnStatusRecord,
    deriveTeamLaunchAggregateState: ports.live.deriveTeamLaunchAggregateState,
  });
}

export async function resolveLiveOrPersistedMemberSpawnStatusesSnapshot<
  TRun extends MemberSpawnStatusRun,
>(
  teamName: string,
  ports: MemberSpawnStatusesSnapshotPorts<TRun>
): Promise<MemberSpawnStatusesSnapshot> {
  const runId = ports.cache.getTrackedRunId(teamName);
  const run = runId ? ports.getRun(runId) : undefined;
  if (!run) {
    return readPersistedMemberSpawnStatusesSnapshot({
      teamName,
      resolvedRunId: runId ?? null,
      ports,
    });
  }

  const generationAtStart = ports.cache.getCacheGeneration(teamName);
  if (!shouldCacheMemberSpawnStatusesSnapshot(run)) {
    return overlayStoppedLiveSpawnSnapshot(
      teamName,
      await buildMemberSpawnStatusesSnapshotForRun(run, ports, generationAtStart),
      ports
    );
  }

  const cached = ports.cache.snapshotCache.get(teamName);
  if (
    cached &&
    cached.expiresAtMs > ports.cache.nowMs() &&
    cached.runId === run.runId &&
    cached.generation === generationAtStart
  ) {
    return overlayStoppedLiveSpawnSnapshot(
      teamName,
      cloneMemberSpawnStatusesSnapshot(cached.snapshot),
      ports
    );
  }

  const existingRequest = ports.cache.inFlightByTeam.get(teamName);
  if (
    existingRequest?.generationAtStart === generationAtStart &&
    existingRequest.runIdAtStart === run.runId
  ) {
    const snapshot = await existingRequest.promise;
    if (
      ports.cache.getCacheGeneration(teamName) === generationAtStart &&
      ports.cache.getTrackedRunId(teamName) === run.runId
    ) {
      return overlayStoppedLiveSpawnSnapshot(
        teamName,
        cloneMemberSpawnStatusesSnapshot(snapshot),
        ports
      );
    }
    return resolveLiveOrPersistedMemberSpawnStatusesSnapshot(teamName, ports);
  }

  const request = buildMemberSpawnStatusesSnapshotForRun(run, ports, generationAtStart).finally(
    () => {
      if (ports.cache.inFlightByTeam.get(teamName)?.promise === request) {
        ports.cache.inFlightByTeam.delete(teamName);
      }
    }
  );
  ports.cache.inFlightByTeam.set(teamName, {
    generationAtStart,
    runIdAtStart: run.runId,
    promise: request,
  });
  const snapshot = await request;
  if (
    ports.cache.getCacheGeneration(teamName) === generationAtStart &&
    ports.cache.getTrackedRunId(teamName) === run.runId
  ) {
    return overlayStoppedLiveSpawnSnapshot(
      teamName,
      cloneMemberSpawnStatusesSnapshot(snapshot),
      ports
    );
  }
  return resolveLiveOrPersistedMemberSpawnStatusesSnapshot(teamName, ports);
}
