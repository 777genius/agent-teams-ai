import { isOpenCodeRuntimeUsable } from '@features/runtime-provider-management/renderer';

import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';

/** Detection permits a read-only model query, never grants launch authority. */
export function canLoadOpenCodeDashboardCatalog(
  provider: CliProviderStatus | null,
  runtime: OpenCodeRuntimeStatus | null
): boolean {
  return Boolean(
    provider &&
    (provider.supported ||
      isOpenCodeRuntimeUsable(runtime) ||
      provider.externalRuntimeDiagnostics?.some(
        (diagnostic) =>
          diagnostic.detected &&
          (diagnostic.id === 'opencode-live-host' || diagnostic.id === 'opencode-managed-runtime')
      ))
  );
}
