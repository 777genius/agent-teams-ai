import { isAnthropicCompatibleBaseUrl } from '../../runtime/anthropicCompatibleEndpoint';
import { resolveAnthropicRuntimeBackendFromEnv } from '../../runtime/providerRuntimeEnv';

import type { TeamProviderId } from '@shared/types';

/** Keep the generic probe on the user's legacy fast model only for a gateway. */
export function getAnthropicCompatibleDiagnosticModelOverride(
  providerId: TeamProviderId,
  env: NodeJS.ProcessEnv
): string | undefined {
  if (
    providerId !== 'anthropic' ||
    !isAnthropicCompatibleBaseUrl(env.ANTHROPIC_BASE_URL) ||
    resolveAnthropicRuntimeBackendFromEnv(env) !== 'anthropic'
  ) {
    return undefined;
  }
  const entryProvider = env.CLAUDE_CODE_ENTRY_PROVIDER?.trim();
  if (entryProvider && entryProvider !== 'anthropic') {
    return undefined;
  }
  return env.ANTHROPIC_SMALL_FAST_MODEL?.trim() || undefined;
}
