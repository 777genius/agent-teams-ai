import { hasMixedPersistedLaunchMetadata } from '../TeamLaunchStateEvaluator';

import { matchesTeamMemberIdentity } from './TeamProvisioningMemberIdentity';

import type {
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
} from '../runtime/TeamRuntimeAdapter';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchSnapshot,
  PersistedTeamLaunchSummary,
} from '@shared/types';

export interface LaunchStateProjectionRunLike {
  isLaunch?: boolean;
  deterministicBootstrap?: boolean;
  expectedMembers?: readonly string[];
  memberSpawnStatuses?: ReadonlyMap<string, MemberSpawnStatusEntry>;
  mixedSecondaryLanes?: readonly LaunchStateProjectionSecondaryLaneLike[];
}

export interface LaunchStateProjectionSecondaryLaneLike {
  member: { name: string };
  state: string;
  runId?: string | null;
  result?: TeamRuntimeLaunchResult | null;
}

export function getPersistedLaunchMemberNames(snapshot: PersistedTeamLaunchSnapshot): string[] {
  return Array.from(new Set([...snapshot.expectedMembers, ...Object.keys(snapshot.members)]));
}

export function getMemberLaunchSummary(
  run: Pick<LaunchStateProjectionRunLike, 'expectedMembers' | 'memberSpawnStatuses'>
): PersistedTeamLaunchSummary {
  const expectedMembers = run.expectedMembers ?? [];
  const memberSpawnStatuses = run.memberSpawnStatuses ?? new Map<string, MemberSpawnStatusEntry>();
  let confirmedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let runtimeAlivePendingCount = 0;
  let shellOnlyPendingCount = 0;
  let runtimeProcessPendingCount = 0;
  let runtimeCandidatePendingCount = 0;
  let noRuntimePendingCount = 0;
  let permissionPendingCount = 0;

  for (const expected of expectedMembers) {
    const entry = memberSpawnStatuses.get(expected);
    if (entry?.launchState === 'confirmed_alive') {
      confirmedCount += 1;
      continue;
    }
    if (entry?.launchState === 'skipped_for_launch' || entry?.skippedForLaunch === true) {
      skippedCount += 1;
      continue;
    }
    if (entry?.launchState === 'failed_to_start') {
      failedCount += 1;
      continue;
    }
    pendingCount += 1;
    if (entry?.runtimeAlive) {
      runtimeAlivePendingCount += 1;
    }
    if (entry?.launchState === 'runtime_pending_permission') {
      permissionPendingCount += 1;
    }
    if (entry?.livenessKind === 'shell_only') {
      shellOnlyPendingCount += 1;
    } else if (entry?.livenessKind === 'runtime_process') {
      runtimeProcessPendingCount += 1;
    } else if (entry?.livenessKind === 'runtime_process_candidate') {
      runtimeCandidatePendingCount += 1;
    } else if (
      entry?.livenessKind === 'not_found' ||
      entry?.livenessKind === 'stale_metadata' ||
      entry?.livenessKind === 'registered_only'
    ) {
      noRuntimePendingCount += 1;
    }
  }

  return {
    confirmedCount,
    pendingCount,
    failedCount,
    skippedCount,
    runtimeAlivePendingCount,
    shellOnlyPendingCount,
    runtimeProcessPendingCount,
    runtimeCandidatePendingCount,
    noRuntimePendingCount,
    permissionPendingCount,
  };
}

export function shouldOverlayPrimaryBootstrapTruth(
  run: Pick<
    LaunchStateProjectionRunLike,
    'isLaunch' | 'deterministicBootstrap' | 'mixedSecondaryLanes'
  >
): boolean {
  return (
    run.isLaunch === true ||
    run.deterministicBootstrap === true ||
    (run.mixedSecondaryLanes?.length ?? 0) > 0
  );
}

export function resolveOpenCodeSecondaryLaneMemberEvidence(
  lane: Pick<LaunchStateProjectionSecondaryLaneLike, 'result'> | undefined,
  memberName: string
): TeamRuntimeMemberLaunchEvidence | undefined {
  if (!lane?.result) {
    return undefined;
  }
  return (
    lane.result.members[memberName] ??
    Object.values(lane.result.members).find((member) =>
      matchesTeamMemberIdentity(member.memberName ?? '', memberName)
    )
  );
}

export function areAllExpectedLaunchMembersConfirmed(
  run: Pick<
    LaunchStateProjectionRunLike,
    'expectedMembers' | 'memberSpawnStatuses' | 'mixedSecondaryLanes'
  >
): boolean {
  const expectedMembers = run.expectedMembers ?? [];
  if (expectedMembers.length === 0) {
    return false;
  }

  const secondaryLanes = run.mixedSecondaryLanes ?? [];
  const confirmedSecondaryMembers = new Set<string>();
  for (const lane of secondaryLanes) {
    const memberName = lane.member.name.trim();
    if (!memberName) {
      return false;
    }
    if (lane.state !== 'finished' || !lane.result) {
      return false;
    }
    if (lane.runId && lane.result.runId !== lane.runId) {
      return false;
    }
    const evidence = resolveOpenCodeSecondaryLaneMemberEvidence(lane, memberName);
    if (
      evidence?.launchState !== 'confirmed_alive' ||
      evidence.bootstrapConfirmed !== true ||
      evidence.hardFailure === true
    ) {
      return false;
    }
    confirmedSecondaryMembers.add(memberName);
  }

  return expectedMembers.every((memberName) => {
    const member = run.memberSpawnStatuses?.get(memberName);
    if (member?.launchState !== 'confirmed_alive' || member.bootstrapConfirmed !== true) {
      return false;
    }
    const isSecondaryMember = secondaryLanes.some((lane) =>
      matchesTeamMemberIdentity(lane.member.name, memberName)
    );
    return !isSecondaryMember || confirmedSecondaryMembers.has(memberName);
  });
}

export function hasMixedLaunchMetadata(snapshot: PersistedTeamLaunchSnapshot | null): boolean {
  return hasMixedPersistedLaunchMetadata(snapshot);
}

export function hasMixedSecondaryLaunchMetadata(
  snapshot: PersistedTeamLaunchSnapshot | null
): boolean {
  if (!snapshot) {
    return false;
  }
  return Object.values(snapshot.members).some(
    (member) =>
      member?.laneKind === 'secondary' ||
      (typeof member?.laneId === 'string' && member.laneId.startsWith('secondary:'))
  );
}

export function hasPrimaryOnlyLaneAwareLaunchMetadata(
  snapshot: PersistedTeamLaunchSnapshot | null
): boolean {
  if (!snapshot || hasMixedSecondaryLaunchMetadata(snapshot)) {
    return false;
  }

  return Object.values(snapshot.members).some(
    (member) =>
      Boolean(member?.laneId) ||
      Boolean(member?.laneKind) ||
      Boolean(member?.laneOwnerProviderId) ||
      Boolean(member?.launchIdentity)
  );
}

export function areLaunchStateSnapshotsSemanticallyEqual(
  left: PersistedTeamLaunchSnapshot,
  right: PersistedTeamLaunchSnapshot
): boolean {
  return (
    JSON.stringify(toLaunchStateSemanticValue(left)) ===
    JSON.stringify(toLaunchStateSemanticValue(right))
  );
}

export function toLaunchStateSemanticValue(snapshot: PersistedTeamLaunchSnapshot): unknown {
  const { updatedAt: _updatedAt, members, ...rest } = snapshot;
  const stableMembers = Object.fromEntries(
    Object.entries(members)
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
      .map(([memberName, member]) => {
        const {
          lastEvaluatedAt: _lastEvaluatedAt,
          lastRuntimeAliveAt: _lastRuntimeAliveAt,
          ...stableMember
        } = member;
        return [memberName, stableMember];
      })
  );
  return toStableJsonValue({
    ...rest,
    members: stableMembers,
  });
}

export function toStableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toStableJsonValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entryValue]) => [key, toStableJsonValue(entryValue)])
  );
}
