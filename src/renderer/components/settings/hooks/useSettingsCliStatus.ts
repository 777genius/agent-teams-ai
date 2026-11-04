import { useMemo } from 'react';

import { mergeCodexProviderStatusWithSnapshot } from '@features/codex-account/renderer';
import { useOpenCodeDashboardStatus } from '@renderer/components/dashboard/useOpenCodeDashboardStatus';
import { useStore } from '@renderer/store';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { CliInstallationStatus } from '@shared/types';

/** Settings and its provider dialog consume the same exact project snapshot. */
export function useSettingsCliStatus(input: {
  cliStatus: CliInstallationStatus | null;
  projectPath: string | null;
  enabled: boolean;
  codexSnapshot: CodexAccountSnapshotDto | null;
}): CliInstallationStatus | null {
  const runtimeStatus = useStore((state) => state.openCodeRuntimeStatus);
  const { providerStatus: openCode } = useOpenCodeDashboardStatus({
    cliStatus: input.cliStatus,
    runtimeStatus,
    enabled: input.enabled,
    projectPath: input.projectPath,
  });
  return useMemo(
    () =>
      input.cliStatus
        ? {
            ...input.cliStatus,
            providers: input.cliStatus.providers.map((provider) =>
              provider.providerId === 'opencode' && openCode
                ? openCode.statusCheckOutcome === 'pending'
                  ? { ...openCode, statusMessage: 'Checking...', detailMessage: null }
                  : openCode
                : provider.providerId === 'codex'
                  ? mergeCodexProviderStatusWithSnapshot(provider, input.codexSnapshot)
                  : provider
            ),
          }
        : null,
    [input.cliStatus, input.codexSnapshot, openCode]
  );
}
