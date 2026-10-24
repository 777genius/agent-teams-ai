import { FileTeamRuntimeBindings } from '../adapters/team/FileTeamRuntimeBindings.js';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { applyLaunchConfiguration } from './launchConfiguration.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { RuntimeMemberBinding } from '../team/contracts.js';
import type { TeamRuntimeSelection } from '../team/ports.js';

interface MemberEntryProjection {
  ownerId: string;
  team: HostedTeam;
  baseProfile: RuntimeMemberProfile;
}

/** Rebuild the exact captured entry, including a launch-owned selected restore. No allocation. */
export function createMemberEntry(options: MemberEntryProjection & { root: string }): MemberEntry {
  return projectMemberEntry(options, (delivery) =>
    new FileTeamRuntimeBindings(
      new TeamOwnerStore(options.root, options.team.definition.binding.teamName)
    ).current(delivery)
  );
}

/** Expected metadata for finalizing the original launch record; never a runnable entry. */
export function createPreparedMemberEntry(options: MemberEntryProjection): MemberEntry {
  return projectMemberEntry(options);
}

function projectMemberEntry(
  options: MemberEntryProjection,
  select?: (delivery: RuntimeMemberBinding) => TeamRuntimeSelection | undefined
): MemberEntry {
  const { team, baseProfile } = options;
  let profile = structuredClone(baseProfile);
  const selected = team.definition.members.find((member) => member.memberId === profile.memberId);
  const grant = team.definition.grants.find((row) => row.principalId === profile.principalId);
  if (!selected?.delivery || grant?.memberName !== selected.name)
    throw new RuntimeOwnerError('invalid');
  // These are private launch records, not a new grant. Detached historical entries
  // still have to be reconstructed to inspect custody and preserve their history.
  const selection = select?.(selected.delivery);
  if (selection) {
    if (selection.baseConfigurationDigest !== runtimeDigest(baseProfile))
      throw new RuntimeOwnerError('conflict');
    if (selection.configuration)
      profile = applyLaunchConfiguration(baseProfile, selection.configuration);
    profile.generation = selection.generation;
    if (selection.configurationDigest !== runtimeDigest(profile))
      throw new RuntimeOwnerError('conflict');
  }
  const delivery = selection ? { ...selected.delivery, ...selection.binding } : selected.delivery;
  selected.delivery = delivery;
  if (selection?.skipped !== undefined)
    selected.launchPolicy = selection.skipped ? 'skip' : 'launch';
  const binding = {
    backendId: delivery.backendId,
    teamId: delivery.teamId,
    runId: delivery.runId,
    memberId: delivery.memberId,
    generation: delivery.generation,
  };
  return {
    profile,
    baseProfile: structuredClone(baseProfile),
    team,
    delivery,
    binding,
    config: {
      tenantId: options.ownerId,
      projectId: team.definition.scope.projectId,
      sessionId: profile.sessionId,
      generation: profile.generation,
      configRevision: profile.configRevision,
      requiredCapabilities:
        profile.provider === 'claude' ? ['session.conversation'] : ['text', 'tools'],
    },
    ...(selection ? { selection } : {}),
  };
}
