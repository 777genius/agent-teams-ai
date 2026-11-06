import { effectId } from '../team/identity.js';
import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { teamModelProbeProfile, teamModelProbeEffort } from './teamLaunchModelProbe.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type {
  NativeMemberCreationAuthority,
  NativeMemberCreationInput,
} from '../team/nativeMemberCreationContracts.js';

/** The existing one-off model owner remains the only probe journal/resource owner. */
export async function preflightNativeMemberModel(options: {
  management: Pick<ProviderManagementCoordinator, 'admitTeamProbeProfile' | 'probes'>;
  profile: RuntimeMemberProfile;
  source: NativeMemberCreationAuthority;
  input: NativeMemberCreationInput;
  assertCurrent(): void;
}): Promise<void> {
  const profile = structuredClone(options.profile),
    input = structuredClone(options.input);
  const selected = teamModelProbeProfile(profile),
    effort = teamModelProbeEffort(profile);
  const modelContext = profile.provider === 'claude' ? profile.nativeOptions?.context : undefined;
  const identity = {
    commandId: effectId(
      'native-member-model-probe',
      options.source.team.source.teamId,
      input.commandId
    ),
    profileId: selected.profileId,
    configRevision: selected.configRevision,
  };
  const context = runtimeDigest({
    input,
    inputAuthority: options.source.fingerprint,
    profile: runtimeDigest(profile),
  });
  const current = () => {
    options.assertCurrent();
    options.source.assertCurrent();
  };
  const isCurrent = () => {
    try {
      current();
      return true;
    } catch {
      return false;
    }
  };
  current();
  options.management.admitTeamProbeProfile(selected);
  const owner = options.management.probes;
  let value = owner.start(
    {
      ...identity,
      providerId:
        profile.provider === 'claude'
          ? 'anthropic'
          : profile.provider === 'codex'
            ? 'codex'
            : profile.nativeOptions.providerId,
      modelId: profile.model,
      context,
      ...(effort === undefined ? {} : { effort }),
      ...(modelContext === undefined ? {} : { modelContext }),
    },
    isCurrent
  );
  try {
    while (value.phase === 'running') {
      current();
      if (Date.now() >= value.expiresAt) {
        value = await owner.cancel(identity);
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      current();
      const next = owner.readCurrent(identity);
      if (
        !next ||
        next.context !== context ||
        next.modelId !== profile.model ||
        next.effort !== effort ||
        next.modelContext !== modelContext
      )
        throw new TeamLaunchError('hold', 'native-member-model-observation');
      value = next;
    }
    current();
    if (value.phase !== 'completed' || !value.ok)
      throw new TeamLaunchError('hold', 'native-member-model-preflight');
  } catch (error) {
    // Cleanup only the exact original probe; never replace its command or retry inference.
    if (value.phase === 'running') {
      try {
        await owner.cancel(identity);
      } catch {
        /* Existing owner retains cleanup debt. */
      }
    }
    throw error;
  }
}
