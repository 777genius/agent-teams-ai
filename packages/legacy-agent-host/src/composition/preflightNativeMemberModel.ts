import { captureOpenCodeProbeAccount, capturePreparedModelReference } from './prepareTeamModelReadiness.js';
import { modelReadinessMechanismDigest } from '../team-launch/launchReadiness.js';
import type { ModelReadinessReference } from '../management/commandRecords.js';
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
  management: Pick<ProviderManagementCoordinator, 'admitTeamProbeProfile' | 'probes' | 'readinessTarget'>;
  profile: RuntimeMemberProfile;
  source: NativeMemberCreationAuthority;
  input: NativeMemberCreationInput;
  teamBindingDigest: string;
  assertCurrent(): void;
}): Promise<ModelReadinessReference | undefined> {
  const admittedAt = Date.now();
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
  const retained = selected.provider === 'opencode' && owner.read(identity)
    ? owner.readRetainedProbe(identity.commandId, context) : undefined;
  const account = selected.provider === 'opencode'
    ? captureOpenCodeProbeAccount(selected, { providerId: profile.provider === 'opencode' ? profile.nativeOptions.providerId : '',
      modelId: profile.model }, isCurrent) : undefined;
  let value = owner.startPrepared(
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
    isCurrent, undefined, selected.provider === 'opencode' && (!retained || retained.readinessScope) ? {
      schemaVersion: 1, kind: 'native', teamBindingDigest: options.teamBindingDigest,
      actionDigest: runtimeDigest({ input, authority: options.source.fingerprint }),
      selectionDigest: runtimeDigest(input), sourceRevision: options.source.team.source.runId,
      rosterRevision: input.expectedRosterRevision, mechanismDigest: modelReadinessMechanismDigest(selected),
      workspace: selected.cwd, cutoff: retained?.readinessScope?.cutoff ?? admittedAt + (selected.modelProbeTimeoutMs ?? 90000),
      destinationKeys: [runtimeDigest({ launchId: options.source.team.source.runId, memberId: profile.memberId })],
      ...(account ? { accountDigest: account.digest } : {}),
    } : undefined
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
    return profile.provider === 'opencode' ? capturePreparedModelReference({ management: options.management,
      profile, commandId: identity.commandId, context, kind: 'native', isCurrent }) : undefined;
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
