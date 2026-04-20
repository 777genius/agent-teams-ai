import { mergeCodexProviderStatusWithSnapshot } from './mergeCodexProviderStatusWithSnapshot';

import type { CodexAccountSnapshotDto } from '../contracts';
import type { CliInstallationStatus } from '@shared/types';

export function mergeCodexCliStatusWithSnapshot(
  cliStatus: CliInstallationStatus | null,
  snapshot: CodexAccountSnapshotDto | null
): CliInstallationStatus | null {
  if (!cliStatus || !snapshot) {
    return cliStatus;
  }

  if (!cliStatus.providers.some((provider) => provider.providerId === 'codex')) {
    return cliStatus;
  }

  return {
    ...cliStatus,
    providers: cliStatus.providers.map((provider) =>
      provider.providerId === 'codex'
        ? mergeCodexProviderStatusWithSnapshot(provider, snapshot)
        : provider
    ),
  };
}
