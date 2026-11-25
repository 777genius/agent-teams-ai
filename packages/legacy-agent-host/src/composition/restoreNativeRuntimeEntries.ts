import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { validateNativeLaunchAdditions } from '../team-launch/nativeLaunchAddition.js';
import { runtimeDigest } from '../runtime/identity.js';
import { compileNativeMemberRuntimeCapture, nativeMemberRuntimeCaptureSchema } from './nativeMemberRuntimeCapture.js';
import { nativeMemberHostedTeam } from './createRuntimeNativeMemberCreation.js';
import { createMemberEntry } from './createMemberEntry.js';
import { validateCapturedRuntimeMcpRecipe } from './capturedRuntimeMcpRecipes.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { TeamLaunchRecord } from '../team-launch/contracts.js';

/** Cold metadata join of actual original additions. No probing, claims, inputs, or provider allocation. */
export function restoreNativeRuntimeEntries(options: {
  profile: TeamHostProfile;
  team: HostedTeam;
  entries: MemberEntry[];
  registry: Map<string, MemberEntry>;
  restoring?: boolean;
}): void {
  const { profile, team } = options;
  for (const { addition, receipt, selection } of retainedNativeAdditions(profile, team)) {
    // Even a pre-configuration interruption is reconstructed as expected metadata only.
    const compiled = compileNativeMemberRuntimeCapture(profile, team, addition.capture, options.restoring);
    if (
      compiled.capture.launchId !== (team.launchId ?? team.definition.scope.runId) ||
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
      ...(options.restoring ? { restoring: true } : {}),
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

/** Validate every original addition receipt before any current private recipe is considered. */
export function validateRetainedNativeRuntimeEntries(profile: TeamHostProfile, team: HostedTeam): void {
  retainedNativeAdditions(profile, team);
}

function retainedNativeAdditions(profile: TeamHostProfile, team: HostedTeam) {
  const launchId = team.launchId ?? team.definition.scope.runId;
  const store = new TeamOwnerStore(profile.owner.storageRoot, team.definition.binding.teamName);
  const record = store.read<TeamLaunchRecord>(`launches/${runtimeDigest(launchId)}.json`);
  if (!record?.nativeAdditions?.length) return [];
  validateNativeLaunchAdditions(record);
  const receipts = team.owner.nativeRoster.nativeCreation().retained(profile.principalId);
  return record.nativeAdditions.map(addition => {
    const receipt = receipts.find((row) => row.commandId === addition.commandId),
      selection = receipt?.nativeCreation.selection;
    if (
      !receipt ||
      receipt.revision !== addition.rosterRevision ||
      receipt.nativeCreation.inputAuthority !== addition.inputAuthority
    )
      throw new TeamLaunchError('hold', 'native-member-receipt');
    const capture = nativeMemberRuntimeCaptureSchema.parse(addition.capture);
    if (capture.launchId !== launchId || capture.member.memberId !== addition.member.memberId ||
        capture.mcpRecipeReference.memberId !== capture.member.memberId)
      throw new TeamLaunchError('hold', 'native-member-binding');
    validateCapturedRuntimeMcpRecipe(
      store, capture.commandId, capture.mcpRecipeReference, capture.savedSettings.cwd
    );
    return { addition, receipt, selection };
  });
}
