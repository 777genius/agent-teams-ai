import { useEffect } from 'react';

import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';
import { useStore } from '@renderer/store';

import type { CliProviderId } from '@shared/types';

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
  return snapshot;
}
