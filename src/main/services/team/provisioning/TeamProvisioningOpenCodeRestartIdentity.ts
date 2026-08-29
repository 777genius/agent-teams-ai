import { isLeadMember } from '@shared/utils/leadDetection';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { matchesExactTeamMemberName } from './TeamProvisioningMemberIdentity';

import type { EffectiveConfiguredMember } from './TeamProvisioningMemberStatusProjection';
import type {
  EffortLevel,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  ProviderModelLaunchIdentity,
  TeamConfig,
  TeamFastMode,
  TeamMember,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export interface PureOpenCodeRestartIdentity {
  runtimeRunId: string;
  providerBackendId: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  laneIdentity: ProviderModelLaunchIdentity;
  membersByName: ReadonlyMap<string, PersistedTeamLaunchMemberState>;
}

export interface PureOpenCodeRestartAuthority {
  assertCurrent(): void;
}

export function createPureOpenCodeRestartAuthorityGuard(
  authority: PureOpenCodeRestartAuthority,
  assertRuntimeRunStillCurrent: () => void
): () => void {
  return () => {
    authority.assertCurrent();
    assertRuntimeRunStillCurrent();
  };
}

export function resolvePureOpenCodeRestartPlan<
  T extends {
    name: string;
    providerId?: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: EffortLevel;
    fastMode?: TeamFastMode;
  },
>(input: {
  teamName: string;
  memberName: string;
  config: TeamConfig;
  metaMembers: TeamMember[];
  teamMetaCwd?: string;
  runtimeCwd?: string;
  persistedProjectPath?: string;
  restartIdentity: PureOpenCodeRestartIdentity;
  resolveEffectiveConfiguredMember(
    configuredMembers: TeamConfig['members'],
    metaMembers: TeamMember[],
    memberName: string
  ): EffectiveConfiguredMember | null;
  buildConfiguredProvisioningMember(member: EffectiveConfiguredMember): T;
}): {
  leadMember: NonNullable<TeamConfig['members']>[number] | undefined;
  targetMember: EffectiveConfiguredMember;
  projectPath: string;
  members: T[];
} {
  const requestedMember = input.resolveEffectiveConfiguredMember(
    input.config.members ?? [],
    input.metaMembers,
    input.memberName
  );
  if (!requestedMember) {
    throw new Error(`Member "${input.memberName}" is not configured in team "${input.teamName}"`);
  }
  if (requestedMember.removedAt) {
    throw new Error(`Member "${input.memberName}" has been removed`);
  }
  if (isLeadMember({ name: requestedMember.name, agentType: requestedMember.agentType })) {
    throw new Error('Lead restart is not supported from member controls');
  }
  const leadMember = input.config.members?.find((member) => isLeadMember(member));
  const configuredNames = new Set<string>();
  for (const member of [...(input.config.members ?? []), ...input.metaMembers]) {
    const name = member.name?.trim();
    if (name) configuredNames.add(name);
  }
  const activeMembers = [...configuredNames]
    .map((name) =>
      input.resolveEffectiveConfiguredMember(input.config.members ?? [], input.metaMembers, name)
    )
    .filter((member): member is EffectiveConfiguredMember =>
      Boolean(
        member &&
        !member.removedAt &&
        !isLeadMember({
          name: member.name,
          agentType: member.agentType,
        })
      )
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const targetMember = activeMembers.find((member) =>
    matchesExactTeamMemberName(member.name, requestedMember.name)
  );
  if (!targetMember) {
    throw new Error(`Member "${input.memberName}" is not configured in team "${input.teamName}"`);
  }
  const projectPath =
    targetMember.cwd?.trim() ||
    input.config.projectPath?.trim() ||
    input.teamMetaCwd?.trim() ||
    input.runtimeCwd?.trim() ||
    input.persistedProjectPath?.trim();
  if (!projectPath) {
    throw new Error(`Team "${input.teamName}" project path is not available for OpenCode restart`);
  }
  return {
    leadMember,
    targetMember,
    projectPath,
    members: applyCurrentOpenCodeMemberIdentities(
      activeMembers.map(input.buildConfiguredProvisioningMember),
      input.restartIdentity
    ),
  };
}

function identityFingerprint(identity: PureOpenCodeRestartIdentity): string {
  return JSON.stringify({
    lane: identity.laneIdentity,
    members: [...identity.membersByName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, member]) => [
        name,
        member.providerId,
        member.runtimeRunId,
        member.launchIdentity,
      ]),
  });
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
    runtimeRunId: input.runtimeRunId,
    providerBackendId: laneIdentity.providerBackendId!,
    model: laneIdentity.resolvedLaunchModel ?? laneIdentity.selectedModel ?? undefined,
    effort: laneIdentity.resolvedEffort ?? laneIdentity.selectedEffort ?? undefined,
    fastMode: laneIdentity.selectedFastMode ?? undefined,
    laneIdentity,
    membersByName,
  };
}

export function createPureOpenCodeRestartIdentityCurrentGuard(input: {
  runtimeRunId: string;
  memberName: string;
  expectedIdentity: PureOpenCodeRestartIdentity;
  readLaunchSnapshot: () => Promise<PersistedTeamLaunchSnapshot | null>;
  assertRuntimeRunStillCurrent: () => void;
}): () => Promise<void> {
  const expectedFingerprint = identityFingerprint(input.expectedIdentity);
  return async () => {
    input.assertRuntimeRunStillCurrent();
    const currentIdentity = resolvePureOpenCodeRestartIdentity({
      runtimeRunId: input.runtimeRunId,
      memberName: input.memberName,
      launchSnapshot: await input.readLaunchSnapshot(),
    });
    if (identityFingerprint(currentIdentity) !== expectedFingerprint) {
      throw new Error('OpenCode launch-state identity changed during member restart.');
    }
    input.assertRuntimeRunStillCurrent();
  };
}

export function applyCurrentOpenCodeMemberIdentity<
  T extends {
    name: string;
    providerId?: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: EffortLevel;
    fastMode?: TeamFastMode;
  },
>(
  member: T,
  persisted: PersistedTeamLaunchMemberState | undefined,
  aggregateLaneIdentity: ProviderModelLaunchIdentity,
  runtimeRunId: string
): T {
  if (!persisted || normalizeOptionalTeamProviderId(persisted.providerId) !== 'opencode') {
    throw new Error(`Current OpenCode launch identity for member "${member.name}" is missing.`);
  }
  if (persisted.runtimeRunId !== runtimeRunId) {
    throw new Error(
      `Current OpenCode launch identity for member "${member.name}" is not bound to the active adapter run.`
    );
  }
  const identity = requireOpenCodeIdentity(persisted.launchIdentity, `Member "${member.name}"`);
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
    fastMode: identity.selectedFastMode ?? undefined,
  };
}

export function applyCurrentOpenCodeMemberIdentities<
  T extends {
    name: string;
    providerId?: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: EffortLevel;
    fastMode?: TeamFastMode;
  },
>(members: readonly T[], identity: PureOpenCodeRestartIdentity): T[] {
  return members.map((member) =>
    applyCurrentOpenCodeMemberIdentity(
      member,
      identity.membersByName.get(memberKey(member.name)),
      identity.laneIdentity,
      identity.runtimeRunId
    )
  );
}
