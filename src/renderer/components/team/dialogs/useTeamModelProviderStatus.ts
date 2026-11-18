import { useEffect } from 'react';

import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';
import { useProviderReadinessRevalidation } from '@renderer/hooks/useProviderReadinessRevalidation';
import { useStore } from '@renderer/store';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';

import type { CliProviderId } from '@shared/types';

const ANTHROPIC_PROVIDER_IDS = ['anthropic'] as const;

/** Claude settings.model is resolved in the launch cwd, just like OpenCode routes. */
export function useTeamModelProviderStatus(
  providerId: CliProviderId | undefined,
  projectPath: string | null | undefined,
  prefetch = false
): ReturnType<typeof useEffectiveCliProviderStatus> {
  const scopedPath = projectPath?.trim() || null;
  const fetchProviderStatus = useStore((state) => state.fetchCliProviderStatus);
  const scopeRevision = useStore((state) => state.cliProviderStatusScopeRevision);
  const globalAnthropicDefault = useStore(
    (state) =>
      state.cliStatus?.providers.find((provider) => provider.providerId === 'anthropic')
        ?.effectiveDefaultModel
  );
  const scopesAnthropic = providerId === 'anthropic' && globalAnthropicDefault !== undefined;
  const cliStatus = useStore((state) => state.cliStatus);
  const hasScopedAnthropicStatus = useStore((state) =>
    Boolean(
      scopedPath &&
      state.cliProviderStatusByScope?.[getCliProviderStatusScopeKey('anthropic', scopedPath)]
    )
  );
  const snapshot = useEffectiveCliProviderStatus(providerId, {
    projectPath: scopesAnthropic || providerId === 'opencode' ? scopedPath : null,
  });
  useEffect(() => {
    if (!prefetch || !scopesAnthropic || !scopedPath) return;
    void fetchProviderStatus?.('anthropic', {
      projectPath: scopedPath,
      silent: true,
      checkReason: 'launch_preflight',
    });
  }, [
    prefetch,
    fetchProviderStatus,
    globalAnthropicDefault,
    scopesAnthropic,
    scopedPath,
    scopeRevision,
  ]);
  // Initial reads and settings invalidation stay with the prefetch above. Once
  // it has settled, revalidate the exact project's catalog at its own expiry;
  // refreshing global status cannot replace project-scoped launch evidence.
  useProviderReadinessRevalidation(
    prefetch && scopesAnthropic && Boolean(scopedPath) && hasScopedAnthropicStatus,
    ANTHROPIC_PROVIDER_IDS,
    cliStatus,
    { projectPath: scopedPath }
  );
  return snapshot;
}
