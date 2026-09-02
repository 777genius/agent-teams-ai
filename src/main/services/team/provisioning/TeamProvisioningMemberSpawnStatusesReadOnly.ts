import { deriveMemberLaunchState } from './TeamProvisioningLaunchFailurePolicy';
import {
  cloneMemberSpawnStatusesSnapshot,
  type MemberSpawnStatusesPersistedPorts,
  type MemberSpawnStatusesSnapshotPorts,
  type MemberSpawnStatusRun,
} from './TeamProvisioningMemberSpawnSnapshots';
import {
  applyExpiredLaunchGraceToPersistedStatuses,
  summarizeMemberSpawnStatusRecord,
} from './TeamProvisioningMemberSpawnStatusPolicy';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

/**
 * Read-only member spawn statuses.
 *
 * `getMemberSpawnStatusesSnapshot` is a read that writes: on the tracked-run
 * branch it refreshes statuses from the lead inbox, consumes the launch's own
 * audit budget, persists a launch-state snapshot (and clears it when the live
 * snapshot is null), syncs the persisted entries back into the run, and fills
 * the shared snapshot cache. On the persisted branch it repairs task-activity
 * intervals and runs the reconcile, whose writes and clears carry no run id at
 * all. None of that may happen because an external monitor polled an HTTP
 * endpoint during a launch, so this variant projects the same view from the
 * same sources and touches nothing.
 *
 * Deliberately NOT called here: refreshMemberSpawnStatusesFromLeadInbox,
 * maybeAuditMemberSpawnStatuses, persistLaunchStateSnapshot,
 * syncRunMemberSpawnStatusesFromSnapshot, reconcilePersistedLaunchState,
 * repairStaleTaskActivityIntervalsOnce, readTaskActivityRepairLaunchSnapshot,
 * resumeActiveTaskActivityForMembers, snapshotCache.set.
 */
export async function getMemberSpawnStatusesSnapshotReadOnly<TRun extends MemberSpawnStatusRun>(
  teamName: string,
  ports: MemberSpawnStatusesSnapshotPorts<TRun>
): Promise<MemberSpawnStatusesSnapshot> {
  const runId = ports.cache.getTrackedRunId(teamName);
  const run = runId ? ports.getRun(runId) : undefined;
  const generation = ports.cache.getCacheGeneration(teamName);
  const cached = ports.cache.snapshotCache.get(teamName);
  if (
    cached &&
    cached.expiresAtMs > ports.cache.nowMs() &&
    cached.runId === (run?.runId ?? runId) &&
    cached.generation === generation
  ) {
    return cloneMemberSpawnStatusesSnapshot(cached.snapshot);
  }

  const persisted = await ports.live.readLaunchState(teamName);
  const launchPhase = run?.provisioningComplete ? 'finished' : 'active';
  // Same fallback as the writing variant: a tracked run that builds no live
  // snapshot (a non-launch run, e.g. create-team) must still be projected from
  // its own member statuses, not served as the previous run's persisted file
  // stamped with the current run id.
  const liveSnapshot: PersistedTeamLaunchSnapshot | null = run
    ? (ports.live.buildLiveLaunchSnapshotForRun(run, launchPhase) ??
      ports.live.buildSnapshotFromRuntimeMemberStatuses({
        teamName: run.teamName,
        expectedMembers: run.expectedMembers,
        leadSessionId: run.detectedSessionId ?? undefined,
        launchPhase,
        statuses: ports.live.buildRuntimeSpawnStatusRecord(run),
      }))
    : null;
  const metaMembers = await ports.live.getMembersMeta(teamName).catch(() => []);
  const launchSnapshot = ports.live.filterRemovedMembersFromLaunchSnapshot(
    liveSnapshot ?? persisted,
    metaMembers
  );
  const projected = ports.live.snapshotToMemberSpawnStatuses(launchSnapshot);
  const openCodeSecondaryBootstrapPendingMembers =
    ports.persisted.getOpenCodeSecondaryBootstrapPendingMemberNames(launchSnapshot);
  const statuses = liveSnapshot
    ? await ports.persisted.attachLiveRuntimeMetadataToStatuses(teamName, projected, {
        openCodeSecondaryBootstrapPendingMembers,
      })
    : await attachLiveRuntimeLivenessToPersistedStatuses({
        teamName,
        statuses: projected,
        attach: ports.persisted.attachLiveRuntimeMetadataToStatuses,
        openCodeSecondaryBootstrapPendingMembers,
      });
  // Pure in-place transform on a record this projection owns: without it a
  // member whose process died mid-launch still reads as "waiting".
  applyExpiredLaunchGraceToPersistedStatuses(statuses, ports.cache.nowMs());
  const expectedMembers = ports.live.getPersistedLaunchMemberNames(launchSnapshot);
  const summary = summarizeMemberSpawnStatusRecord(expectedMembers, statuses);
  return {
    statuses,
    runId: run?.runId ?? runId ?? null,
    teamLaunchState: ports.live.deriveTeamLaunchAggregateState(summary),
    launchPhase: launchSnapshot?.launchPhase,
    expectedMembers,
    updatedAt: launchSnapshot?.updatedAt,
    summary,
    source: liveSnapshot ? (persisted ? 'merged' : 'live') : 'persisted',
  };
}

/**
 * Write-free liveness half of `reconcilePersistedLaunchMember`.
 *
 * `launch-state.json` keeps whatever the last launch wrote, so a persisted
 * `runtimeAlive: true` outlives the process it described - the writing reconcile
 * is the only place that reassigns it from live evidence
 * (`runtimeAlive = observedRuntimeAlive`), and this projection must not run it.
 * `attachLiveRuntimeMetadataToStatuses` carries the same live evidence but only
 * rewrites members it has runtime metadata for (never the lead), stamping each
 * one with `livenessLastCheckedAt`. Clearing that stamp before the call turns it
 * into an exact marker of which members the live pass actually evaluated: the
 * rest have no live proof at all and must not be reported alive, which is how a
 * stopped team's lead read as alive over HTTP while the UI reported it dead.
 */
export async function attachLiveRuntimeLivenessToPersistedStatuses(input: {
  teamName: string;
  statuses: Record<string, MemberSpawnStatusEntry>;
  attach: MemberSpawnStatusesPersistedPorts['attachLiveRuntimeMetadataToStatuses'];
  openCodeSecondaryBootstrapPendingMembers: ReadonlySet<string>;
}): Promise<Record<string, MemberSpawnStatusEntry>> {
  const persistedLivenessChecks = new Map<string, string | undefined>();
  const probed: Record<string, MemberSpawnStatusEntry> = {};
  for (const [memberName, entry] of Object.entries(input.statuses)) {
    persistedLivenessChecks.set(memberName, entry.livenessLastCheckedAt);
    probed[memberName] = { ...entry, livenessLastCheckedAt: undefined };
  }
  const attached = await input.attach(input.teamName, probed, {
    openCodeSecondaryBootstrapPendingMembers: input.openCodeSecondaryBootstrapPendingMembers,
  });
  const statuses: Record<string, MemberSpawnStatusEntry> = {};
  for (const [memberName, entry] of Object.entries(attached)) {
    statuses[memberName] = entry.livenessLastCheckedAt
      ? entry
      : demoteUncheckedRuntimeLiveness(entry, persistedLivenessChecks.get(memberName));
  }
  return statuses;
}

/** One member the live liveness pass never evaluated: its `runtimeAlive` is hearsay. */
function demoteUncheckedRuntimeLiveness(
  entry: MemberSpawnStatusEntry,
  persistedLivenessLastCheckedAt: string | undefined
): MemberSpawnStatusEntry {
  const next: MemberSpawnStatusEntry = {
    ...entry,
    livenessLastCheckedAt: persistedLivenessLastCheckedAt,
  };
  if (entry.runtimeAlive !== true) {
    return next;
  }
  next.runtimeAlive = false;
  next.launchState = deriveMemberLaunchState(next);
  if (
    next.launchState === 'runtime_pending_bootstrap' ||
    next.launchState === 'runtime_pending_permission'
  ) {
    // Mirrors `snapshotToMemberSpawnStatuses`: without a live runtime there is
    // no process liveness to report, so the member is waiting, not online.
    next.status = 'waiting';
    next.livenessSource = undefined;
  } else if (next.livenessSource === 'process') {
    next.livenessSource = undefined;
  }
  return next;
}
