import { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import { RuntimeSourceIndex } from './RuntimeSourceIndex.js';
import { teamModelProbeProfile } from './teamLaunchModelProbe.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { ProviderOAuthSnapshot } from '../management/contracts.js';
import type { RegisteredProcessRootSource } from '../process/registeredProcessContracts.js';

/** Restore source-derived private profiles before existing operation owners read their journals. */
export function createHostProviderManagementComposition(
  profile: TeamHostProfile,
  assertWriter: () => void,
  onOAuthProgress: (snapshot: ProviderOAuthSnapshot) => void,
  processCustody?: RegisteredProcessRootSource,
  assertCleanupWriter = assertWriter
) {
  const sources = profile.management?.length
    ? new RuntimeSourceIndex(profile, assertWriter, {
        assertCleanupWriter,
        ...(processCustody ? { processCustody } : {}),
      })
    : undefined;
  const profiles = [
    ...(profile.management ?? []),
    ...(sources?.retainedManagementProfiles() ?? []),
    ...(profile.runtime?.members.flatMap((member) => {
      if (
        member.provider === 'opencode' &&
        member.nativeGeneration === 'v2' &&
        !(member.protocolRevision === '2.1.4' && member.embedded)
      )
        return [];
      return [teamModelProbeProfile(member)];
    }) ?? []),
  ];
  const required =
    profiles.length ||
    (profile.creation &&
      profile.runtime?.providerTemplates?.some(
        (row) =>
          row.provider === 'claude' ||
          (row.provider === 'opencode' &&
            row.nativeGeneration === 'v2' &&
            row.protocolRevision === '2.1.4' &&
            row.embedded !== undefined)
      ));
  return {
    sources,
    management: required
      ? new ProviderManagementCoordinator(profiles, assertWriter, profile.owner.storageRoot, {
          onOAuthProgress,
          ...(processCustody ? { processCustody } : {}),
        })
      : undefined,
  };
}
