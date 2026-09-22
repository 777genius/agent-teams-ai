import { useMemo } from 'react';

import { useOpenCodeLocalProviders } from '@features/runtime-provider-management/renderer';

import type { TeamProviderId } from '@shared/types';

interface MemberProviderSelection {
  providerId?: TeamProviderId;
  removedAt?: number | string | null;
}

export interface OpenCodeLocalModelScope {
  openCodeLocalProviderIds: ReadonlySet<string>;
  openCodeLocalProviderLookupAuthoritative: boolean;
}

export function shouldEnableOpenCodeLocalModelScopeLookup(input: {
  enabled: boolean;
  projectPath: string;
  requiresLookup: boolean;
}): boolean {
  return input.enabled && input.requiresLookup && Boolean(input.projectPath.trim());
}

export function useOpenCodeLocalModelScope(input: {
  enabled: boolean;
  projectPath: string;
  selectedProviderId: TeamProviderId;
  members: readonly MemberProviderSelection[];
}): OpenCodeLocalModelScope {
  const requiresLookup =
    input.selectedProviderId === 'opencode' ||
    input.members.some((member) => !member.removedAt && member.providerId === 'opencode');
  const projectPath = input.projectPath.trim();
  const lookupEnabled = shouldEnableOpenCodeLocalModelScopeLookup({
    enabled: input.enabled,
    projectPath,
    requiresLookup,
  });
  const { providers, authoritative } = useOpenCodeLocalProviders({
    enabled: lookupEnabled,
    projectPath: projectPath || null,
  });

  return useMemo(
    () => ({
      openCodeLocalProviderIds: new Set(
        providers.map((provider) => provider.providerId.trim().toLowerCase())
      ),
      openCodeLocalProviderLookupAuthoritative: lookupEnabled && authoritative,
    }),
    [authoritative, lookupEnabled, providers]
  );
}
