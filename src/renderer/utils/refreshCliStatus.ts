import type { CliInstallerProviderStatusMode } from '@shared/types';

interface RefreshCliStatusOptions {
  multimodelEnabled: boolean;
  providerStatusMode?: CliInstallerProviderStatusMode;
  bootstrapCliStatus: (options?: {
    multimodelEnabled?: boolean;
    providerStatusMode?: CliInstallerProviderStatusMode;
  }) => Promise<void>;
  fetchCliStatus: () => Promise<void>;
}

export function refreshCliStatusForCurrentMode({
  multimodelEnabled,
  providerStatusMode,
  bootstrapCliStatus,
  fetchCliStatus,
}: RefreshCliStatusOptions): Promise<void> {
  if (multimodelEnabled) {
    return bootstrapCliStatus(
      providerStatusMode
        ? { multimodelEnabled: true, providerStatusMode }
        : { multimodelEnabled: true }
    );
  }

  return fetchCliStatus();
}
