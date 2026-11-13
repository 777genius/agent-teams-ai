import { readOpenCodeConfiguredModel } from './openCodeSelectedProviderConfiguration.js';
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
  if (candidate.openCodePreferences)
    profile.managedPreferences = structuredClone(candidate.openCodePreferences);
  if (profile.embedded) profile.embedded = {
    ...profile.embedded,
    ...candidate.embedded,
    ...(candidate.openCodeConfiguration
      ? { configurationSource: candidate.openCodeConfiguration }
      : {}),
  };
  const selected = readOpenCodeConfiguredModel({ model: candidate.openCodePreferences?.defaultModelId ?? undefined })
    ?? candidate.openCodeDefault;
  if (!selected) return profile;
  const previous =
    'profileId' in profile ? profile.nativeModel?.providerId : profile.nativeOptions.providerId;
  if (profile.embedded && previous !== selected.providerId) delete profile.embedded.providerConfiguration;
  if ('profileId' in profile) {
    if (profile.nativeGeneration === 'v2')
      profile.nativeModel = { providerId: selected.providerId, modelId: selected.modelId };
    else {
      const config: unknown = JSON.parse(profile.environment.OPENCODE_CONFIG_CONTENT ?? '{}');
      if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new Error('Invalid captured OpenCode config');
      profile.environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        ...config, model: `${selected.providerId}/${selected.modelId}`,
      });
    }
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
