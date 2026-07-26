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

export function useOpenCodeLocalModelScope(input: {
  enabled: boolean;
  projectPath: string;
  selectedProviderId: TeamProviderId;
  members: readonly MemberProviderSelection[];
}): OpenCodeLocalModelScope {
  const requiresLookup =
    input.selectedProviderId === 'opencode' ||
    input.members.some((member) => !member.removedAt && member.providerId === 'opencode');
  const { providers, authoritative } = useOpenCodeLocalProviders({
    enabled: input.enabled && requiresLookup,
    projectPath: input.projectPath || null,
  });

  return useMemo(
    () => ({
      openCodeLocalProviderIds: new Set(
        providers.map((provider) => provider.providerId.trim().toLowerCase())
      ),
      openCodeLocalProviderLookupAuthoritative: authoritative,
    }),
    [authoritative, providers]
  );
}
