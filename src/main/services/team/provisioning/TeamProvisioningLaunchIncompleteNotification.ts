import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

export interface LaunchIncompleteLaunchSummary {
  confirmedCount: number;
  pendingCount: number;
  failedCount: number;
  runtimeAlivePendingCount: number;
  runtimeProcessPendingCount?: number;
}

export interface LaunchIncompleteRunLike {
  teamName: string;
  runId: string;
  request: {
    displayName?: string;
    cwd: string;
  };
  expectedMembers?: readonly string[];
  allEffectiveMembers?: readonly { name?: string | null }[];
  memberSpawnStatuses?: ReadonlyMap<string, MemberSpawnStatusEntry>;
}

export interface LaunchIncompleteMemberEvidence {
  live?: MemberSpawnStatusEntry;
  persisted?: PersistedTeamLaunchMemberState;
}

function isPresentMemberName(name: string | null | undefined): name is string {
  return Boolean(name);
}

function isResolvedLaunchEvidence(
  evidence: LaunchIncompleteMemberEvidence['live'] | LaunchIncompleteMemberEvidence['persisted']
): boolean {
  return (
    evidence?.launchState === 'confirmed_alive' ||
    evidence?.bootstrapConfirmed === true ||
    evidence?.launchState === 'skipped_for_launch' ||
    evidence?.skippedForLaunch === true
  );
}

function isConfirmedLaunchEvidence(
  evidence: LaunchIncompleteMemberEvidence['live'] | LaunchIncompleteMemberEvidence['persisted']
): boolean {
  return evidence?.launchState === 'confirmed_alive' || evidence?.bootstrapConfirmed === true;
}

function isSkippedLaunchEvidence(
  evidence: LaunchIncompleteMemberEvidence['live'] | LaunchIncompleteMemberEvidence['persisted']
): boolean {
  return evidence?.launchState === 'skipped_for_launch' || evidence?.skippedForLaunch === true;
}

function isFailedLaunchEvidence(
  evidence: LaunchIncompleteMemberEvidence['live'] | LaunchIncompleteMemberEvidence['persisted']
): boolean {
  return evidence?.launchState === 'failed_to_start' || evidence?.hardFailure === true;
}

export function getLaunchIncompleteExpectedMembers(
  run: Pick<LaunchIncompleteRunLike, 'expectedMembers' | 'allEffectiveMembers'>,
  snapshot?: PersistedTeamLaunchSnapshot | null
): string[] {
  return [
    ...new Set(
      [
        ...(snapshot?.expectedMembers ?? []),
        ...(run.expectedMembers ?? []),
        ...(run.allEffectiveMembers ?? []).map((member) => member.name).filter(isPresentMemberName),
      ].filter(isPresentMemberName)
    ),
  ];
}

export function getLaunchIncompleteMemberEvidence(
  run: Pick<LaunchIncompleteRunLike, 'memberSpawnStatuses'>,
  snapshot: PersistedTeamLaunchSnapshot | null | undefined,
  memberName: string
): LaunchIncompleteMemberEvidence {
  return {
    live: run.memberSpawnStatuses?.get(memberName),
    persisted: snapshot?.members[memberName],
  };
}

export function formatLaunchIncompleteMemberMentions(names: readonly string[]): string {
  return names.map((name) => `@${name}`).join(', ');
}

export function getLaunchIncompleteFailedNames(
  run: Pick<LaunchIncompleteRunLike, 'memberSpawnStatuses'>,
  expectedMembers: readonly string[],
  failedMembers: readonly { name?: string | null }[],
  snapshot?: PersistedTeamLaunchSnapshot | null
): string[] {
  const failedNames = new Set(
    failedMembers.map((member) => member.name).filter(isPresentMemberName)
  );
  for (const memberName of expectedMembers) {
    const { live, persisted } = getLaunchIncompleteMemberEvidence(run, snapshot, memberName);
    if (isResolvedLaunchEvidence(live) || isResolvedLaunchEvidence(persisted)) {
      failedNames.delete(memberName);
      continue;
    }
    if (isFailedLaunchEvidence(live) || isFailedLaunchEvidence(persisted)) {
      failedNames.add(memberName);
    }
  }
  return [...failedNames].sort((left, right) => left.localeCompare(right));
}

export function getLaunchIncompletePendingNames(
  run: Pick<LaunchIncompleteRunLike, 'memberSpawnStatuses'>,
  expectedMembers: readonly string[],
  failedNames: readonly string[],
  snapshot?: PersistedTeamLaunchSnapshot | null
): string[] {
  const failed = new Set(failedNames);
  return expectedMembers
    .filter((memberName) => {
      if (failed.has(memberName)) {
        return false;
      }
      const { live, persisted } = getLaunchIncompleteMemberEvidence(run, snapshot, memberName);
      const hasEvidence = live !== undefined || persisted !== undefined;
      if (!hasEvidence) {
        return false;
      }
      if (isConfirmedLaunchEvidence(live) || isConfirmedLaunchEvidence(persisted)) {
        return false;
      }
      return !isSkippedLaunchEvidence(live) && !isSkippedLaunchEvidence(persisted);
    })
    .sort((left, right) => left.localeCompare(right));
}

export function getLaunchIncompleteJoinedCount(
  run: Pick<LaunchIncompleteRunLike, 'memberSpawnStatuses'>,
  expectedMembers: readonly string[],
  namedMissingCount: number,
  launchSummary: Pick<LaunchIncompleteLaunchSummary, 'confirmedCount'>,
  snapshot?: PersistedTeamLaunchSnapshot | null
): number {
  const evidenceConfirmedCount = expectedMembers.filter((memberName) => {
    const { live, persisted } = getLaunchIncompleteMemberEvidence(run, snapshot, memberName);
    return isConfirmedLaunchEvidence(live) || isConfirmedLaunchEvidence(persisted);
  }).length;
  const namedMissingUpperBound = expectedMembers.length - namedMissingCount;
  const rawJoinedCount =
    namedMissingCount > 0
      ? Math.min(
          namedMissingUpperBound,
          Math.max(evidenceConfirmedCount, launchSummary.confirmedCount)
        )
      : Math.max(evidenceConfirmedCount, launchSummary.confirmedCount);
  return Math.max(0, Math.min(expectedMembers.length, rawJoinedCount));
}

export function buildTeamLaunchIncompleteNotificationPayload(params: {
  run: LaunchIncompleteRunLike;
  failedMembers: readonly { name?: string | null }[];
  launchSummary: LaunchIncompleteLaunchSummary;
  snapshot?: PersistedTeamLaunchSnapshot | null;
  suppressToast: boolean;
}): TeamNotificationPayload | null {
  const { run, failedMembers, launchSummary, snapshot, suppressToast } = params;
  const displayName = run.request.displayName || run.teamName;
  const expectedMembers = getLaunchIncompleteExpectedMembers(run, snapshot);
  const expectedCount = expectedMembers.length;
  if (expectedCount === 0) return null;

  const failedNames = getLaunchIncompleteFailedNames(run, expectedMembers, failedMembers, snapshot);
  if (failedNames.length === 0) {
    return null;
  }
  const pendingNames = getLaunchIncompletePendingNames(run, expectedMembers, failedNames, snapshot);
  const joinedCount = getLaunchIncompleteJoinedCount(
    run,
    expectedMembers,
    failedNames.length + pendingNames.length,
    launchSummary,
    snapshot
  );
  const missingCount = Math.max(0, launchSummary.pendingCount + launchSummary.failedCount);
  const bodyParts = [`${joinedCount}/${expectedCount} joined`];
  if (failedNames.length > 0) {
    bodyParts.push(`failed: ${formatLaunchIncompleteMemberMentions(failedNames)}`);
  }
  if (pendingNames.length > 0) {
    bodyParts.push(`still joining: ${formatLaunchIncompleteMemberMentions(pendingNames)}`);
  }
  if (bodyParts.length === 1 && missingCount > 0 && joinedCount < expectedCount) {
    const genericMissingCount = Math.min(missingCount, expectedCount - joinedCount);
    bodyParts.push(
      `${genericMissingCount} teammate${genericMissingCount === 1 ? '' : 's'} not joined yet`
    );
  }

  return {
    teamEventType: 'team_launch_incomplete',
    teamName: run.teamName,
    teamDisplayName: displayName,
    from: 'system',
    summary: 'Team launch incomplete',
    body: bodyParts.join(' · '),
    dedupeKey: `team_launch_incomplete:${run.teamName}:${run.runId}`,
    target: { kind: 'team', teamName: run.teamName, section: 'members' },
    projectPath: run.request.cwd,
    suppressToast,
  };
}
