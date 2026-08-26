import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type {
  EffortLevel,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  ProviderModelLaunchIdentity,
  TeamFastMode,
  TeamProviderBackendId,
} from '@shared/types';

export interface PureOpenCodeRestartIdentity {
  providerBackendId: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  laneIdentity: ProviderModelLaunchIdentity;
  membersByName: ReadonlyMap<string, PersistedTeamLaunchMemberState>;
}

function memberKey(name: string): string {
  return name.trim().toLowerCase();
}

function requireOpenCodeIdentity(
  identity: ProviderModelLaunchIdentity | undefined,
  label: string
): ProviderModelLaunchIdentity {
  if (
    normalizeOptionalTeamProviderId(identity?.providerId) !== 'opencode' ||
    !identity?.providerBackendId
  ) {
    throw new Error(`${label} OpenCode launch identity is incomplete or incompatible.`);
  }
  return identity;
}

/**
 * Resolves one current, run-bound identity for the primary OpenCode lane.
 * Historical root/lead metadata fields are never mixed into the affected
 * member's exact active-run identity.
 */
export function resolvePureOpenCodeRestartIdentity(input: {
  runtimeRunId: string;
  memberName: string;
  launchSnapshot: PersistedTeamLaunchSnapshot | null;
}): PureOpenCodeRestartIdentity {
  const snapshot = input.launchSnapshot;
  if (!snapshot || snapshot.stoppedAt) {
    throw new Error('Current OpenCode launch-state identity is unavailable for member restart.');
  }
  const membersByName = new Map<string, PersistedTeamLaunchMemberState>();
  for (const member of Object.values(snapshot.members)) {
    membersByName.set(memberKey(member.name), member);
  }
  const target = membersByName.get(memberKey(input.memberName));
  if (!target) {
    throw new Error(
      `Current OpenCode launch identity for member "${input.memberName}" is missing.`
    );
  }
  const snapshotOwnsRun = snapshot.runtimeRunId === input.runtimeRunId;
  if (!snapshotOwnsRun) {
    throw new Error('OpenCode launch-state identity is not bound to the active adapter run.');
  }

  if (normalizeOptionalTeamProviderId(target.providerId) !== 'opencode') {
    throw new Error('Current member launch-state does not belong to the OpenCode lane.');
  }
  const laneIdentity = requireOpenCodeIdentity(snapshot.primaryLaneIdentity, 'Primary lane');

  return {
    providerBackendId: laneIdentity.providerBackendId!,
    model: laneIdentity.resolvedLaunchModel ?? laneIdentity.selectedModel ?? undefined,
    effort: laneIdentity.resolvedEffort ?? laneIdentity.selectedEffort ?? undefined,
    fastMode: laneIdentity.selectedFastMode ?? undefined,
    laneIdentity,
    membersByName,
  };
}

export function applyCurrentOpenCodeMemberIdentity<
  T extends {
    name: string;
    providerId?: string;
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: EffortLevel;
  },
>(
  member: T,
  persisted: PersistedTeamLaunchMemberState | undefined,
  aggregateLaneIdentity: ProviderModelLaunchIdentity
): T {
  if (!persisted || normalizeOptionalTeamProviderId(persisted.providerId) !== 'opencode') {
    throw new Error(`Current OpenCode launch identity for member "${member.name}" is missing.`);
  }
  const identity = persisted.launchIdentity
    ? requireOpenCodeIdentity(persisted.launchIdentity, `Member "${member.name}"`)
    : aggregateLaneIdentity;
  if (
    identity.providerId !== aggregateLaneIdentity.providerId ||
    identity.providerBackendId !== aggregateLaneIdentity.providerBackendId
  ) {
    throw new Error('OpenCode lead and member launch identities disagree for the active lane.');
  }
  return {
    ...member,
    providerId: 'opencode',
    providerBackendId: identity.providerBackendId ?? undefined,
    model: identity.resolvedLaunchModel ?? identity.selectedModel ?? undefined,
    effort: identity.resolvedEffort ?? identity.selectedEffort ?? undefined,
  };
}

export function applyCurrentOpenCodeMemberIdentities<
  T extends {
    name: string;
    providerId?: string;
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: EffortLevel;
  },
>(members: readonly T[], identity: PureOpenCodeRestartIdentity): T[] {
  return members.map((member) =>
    applyCurrentOpenCodeMemberIdentity(
      member,
      identity.membersByName.get(memberKey(member.name)),
      identity.laneIdentity
    )
  );
}
