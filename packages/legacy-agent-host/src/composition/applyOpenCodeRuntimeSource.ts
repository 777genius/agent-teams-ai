import type { OpenCodeManagementProfile } from '../management/profile.js';
import type { OpenCodeMemberProfile } from './runtimeProfile.js';
import type { RuntimeSourceCandidate } from './runtimeSourceContracts.js';

export function applyOpenCodeRuntimeSource(
  profile: OpenCodeManagementProfile,
  candidate: RuntimeSourceCandidate
): OpenCodeManagementProfile;
export function applyOpenCodeRuntimeSource(
  profile: OpenCodeMemberProfile,
  candidate: RuntimeSourceCandidate
): OpenCodeMemberProfile;
/** Source metadata changes the next base recipe; selected secret values never enter this profile. */
export function applyOpenCodeRuntimeSource(
  raw: OpenCodeManagementProfile | OpenCodeMemberProfile,
  candidate: RuntimeSourceCandidate
): OpenCodeManagementProfile | OpenCodeMemberProfile {
  const profile = structuredClone(raw);
  if (!profile.embedded) return profile;
  profile.embedded = {
    ...profile.embedded,
    ...candidate.embedded,
    ...(candidate.openCodeConfiguration
      ? { configurationSource: candidate.openCodeConfiguration }
      : {}),
  };
  const selected = candidate.openCodeDefault;
  if (!selected) return profile;
  const previous =
    'profileId' in profile ? profile.nativeModel?.providerId : profile.nativeOptions.providerId;
  if (previous !== selected.providerId) delete profile.embedded.providerConfiguration;
  if ('profileId' in profile) {
    profile.nativeModel = { providerId: selected.providerId, modelId: selected.modelId };
    delete profile.variant;
    if (selected.variant !== undefined) profile.variant = selected.variant;
  } else {
    profile.model = selected.modelId;
    profile.nativeOptions.providerId = selected.providerId;
    delete profile.nativeOptions.variant;
    if (selected.variant !== undefined) profile.nativeOptions.variant = selected.variant;
  }
  return profile;
}
