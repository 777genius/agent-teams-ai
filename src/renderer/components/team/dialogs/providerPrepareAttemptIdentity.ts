import type { CliProviderStatus } from '@shared/types';

export function isSameProviderPrepareAttempt(
  previous: string | undefined,
  current: string | undefined
): boolean {
  return previous !== undefined && current !== undefined && previous === current;
}

/** Paid automatic diagnostics track selection/configuration, not passive proof refreshes.
 * Freshness remains in the separate cache key and launch-authority gate. Explicit
 * Re-check invalidates the dialog's attempt record, including same-account recovery.
 */
export function buildProviderPrepareAttemptRuntimeSignature(
  provider: CliProviderStatus | null | undefined
): string {
  const connection = provider?.connection;
  return JSON.stringify({
    selectedBackendId: provider?.selectedBackendId ?? null,
    configuredAuthMode: connection?.configuredAuthMode ?? null,
    apiKeyConfigured: connection?.apiKeyConfigured ?? null,
    apiKeySource: connection?.apiKeySource ?? null,
    compatibleEndpoint: connection?.compatibleEndpoint ?? null,
    codexAuthMode: connection?.codex?.preferredAuthMode ?? null,
    codexAccount: connection?.codex?.managedAccount ?? null,
    codexCustomProvider: connection?.codex?.customProvider
      ? {
          enabled: connection.codex.customProvider.enabled,
          baseUrl: connection.codex.customProvider.baseUrl,
          model: connection.codex.customProvider.model,
        }
      : null,
  });
}
