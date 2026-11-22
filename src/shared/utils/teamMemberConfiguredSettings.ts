import type { TeamMemberConfiguredRuntimeSettings } from '@shared/types';

// Edit canonical overrides, including absent keys, rather than a historical launch projection.
export function getConfiguredTeamMember<
  T extends {
    configuredRuntimeSettings?: TeamMemberConfiguredRuntimeSettings;
  },
>(member: T): T {
  const settings = member.configuredRuntimeSettings;
  if (settings === undefined) return member;
  return {
    ...member,
    providerId: settings.providerId,
    providerBackendId: settings.providerBackendId,
    model: settings.model,
    effort: settings.effort,
    fastMode: settings.fastMode,
  };
}
