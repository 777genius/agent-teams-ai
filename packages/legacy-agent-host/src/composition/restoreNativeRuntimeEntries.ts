import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { validateNativeLaunchAdditions } from '../team-launch/nativeLaunchAddition.js';
import { runtimeDigest } from '../runtime/identity.js';
import { compileNativeMemberRuntimeCapture } from './nativeMemberRuntimeCapture.js';
import { nativeMemberHostedTeam } from './createRuntimeNativeMemberCreation.js';
import { createMemberEntry } from './createMemberEntry.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { TeamLaunchRecord } from '../team-launch/contracts.js';

/** Cold metadata join of actual original additions. No probing, claims, inputs, or provider allocation. */
export function restoreNativeRuntimeEntries(options: {
  profile: TeamHostProfile;
  team: HostedTeam;
  entries: MemberEntry[];
  registry: Map<string, MemberEntry>;
}): void {
  const { profile, team } = options;
  const launchId = team.launchId ?? team.definition.scope.runId;
  const record = new TeamOwnerStore(
    profile.owner.storageRoot,
    team.definition.binding.teamName
  ).read<TeamLaunchRecord>(`launches/${runtimeDigest(launchId)}.json`);
  if (!record?.nativeAdditions?.length) return;
  validateNativeLaunchAdditions(record);
  const receipts = team.owner.nativeRoster.nativeCreation().retained(profile.principalId);
  for (const addition of record.nativeAdditions) {
    const receipt = receipts.find((row) => row.commandId === addition.commandId),
      selection = receipt?.nativeCreation.selection;
    if (
      !receipt ||
      receipt.revision !== addition.rosterRevision ||
      receipt.nativeCreation.inputAuthority !== addition.inputAuthority
    )
      throw new TeamLaunchError('hold', 'native-member-receipt');
    // Even a pre-configuration interruption is reconstructed as expected metadata only.
    const compiled = compileNativeMemberRuntimeCapture(profile, team, addition.capture);
    if (
      compiled.capture.launchId !== launchId ||
      compiled.capture.member.memberId !== addition.member.memberId ||
      (selection && runtimeDigest(compiled.selection) !== runtimeDigest(selection)) ||
      runtimeDigest(compiled.profile) !== addition.member.baseConfigurationDigest
    )
      throw new TeamLaunchError('hold', 'native-member-binding');
    const target = nativeMemberHostedTeam(
      team,
      compiled.capture.member,
      selection ?? compiled.selection,
      receipt.revision
    );
    const entry = createMemberEntry({
      root: profile.owner.storageRoot,
      ownerId: profile.owner.ownerId,
      team: target,
      baseProfile: compiled.profile,
    });
    const key = runtimeDigest(entry.binding),
      prior = options.registry.get(key);
    if (prior && runtimeDigest(prior.baseProfile) !== runtimeDigest(entry.baseProfile))
      throw new TeamLaunchError('hold', 'native-member-binding');
    const selected = prior ?? entry;
    if (!prior) options.registry.set(key, selected);
    if (!options.entries.includes(selected)) options.entries.push(selected);
  }
}
