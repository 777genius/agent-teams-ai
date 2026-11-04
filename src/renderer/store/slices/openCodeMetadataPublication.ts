import { revokeProviderLaunchAuthority } from './cliInstallerStatusReconciliation';

import type { CliInstallerSlice } from './cliInstallerSlice';
import type { CliInstallationStatus, CliProviderId } from '@shared/types';

type StoreSource = () => Pick<CliInstallerSlice, 'cliStatus'>;
interface Replacement {
  inProgress: boolean;
}
const replacements = new WeakMap<StoreSource, Replacement>();

/** Retire metadata from before or during replacement without changing other providers' epochs. */
export function beginOpenCodeRuntimeReplacement(get: StoreSource): () => void {
  const replacement = { inProgress: true };
  replacements.set(get, replacement);
  return () => {
    if (replacements.get(get) === replacement) replacements.set(get, { inProgress: false });
  };
}

export function captureOpenCodeMetadataRead(get: StoreSource): {
  protect: (incoming: CliInstallationStatus) => CliInstallationStatus;
  canHydrate: (providerId: CliProviderId) => boolean;
} {
  const started = replacements.get(get);
  const isCurrent = (): boolean =>
    started?.inProgress !== true && replacements.get(get) === started;
  return {
    canHydrate: (providerId) => providerId !== 'opencode' || isCurrent(),
    protect: (incoming) => {
      if (isCurrent() || incoming.flavor !== 'agent_teams_orchestrator') return incoming;
      const current = get().cliStatus?.providers.find(
        (provider) => provider.providerId === 'opencode'
      );
      const providers = incoming.providers.map((provider) =>
        provider.providerId === 'opencode'
          ? (current ?? revokeProviderLaunchAuthority(provider))
          : provider
      );
      if (current && !providers.some((provider) => provider.providerId === 'opencode'))
        providers.push(current);
      return { ...incoming, providers };
    },
  };
}
