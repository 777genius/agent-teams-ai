import { stripTerminalFormatting } from './runtimeProviderModelTestBoundary';

import type {
  RuntimeProviderManagementErrorDto,
  RuntimeProviderManagementProviderResponse,
} from '@features/runtime-provider-management/contracts';

/**
 * The packaged orchestrator verifies a freshly submitted API key by probing
 * catalog model candidates, e.g. "OpenCode could not verify provider anthropic
 * with 3 model candidates: ...: Not Found". OpenCode only activates a provider
 * once its credential is in the auth store, so for store-activated providers
 * that probe runs without the submitted key and every candidate fails. The
 * matcher stays deliberately loose about wording so minor orchestrator
 * phrasing changes keep matching, while still requiring the "verify provider"
 * core so unrelated auth failures never trigger the fallback.
 */
const VERIFY_FAILURE_PATTERN =
  /\b(?:could ?n[o']t|cannot|can ?not|can't|unable to|failed to) verify (?:the )?provider\b/i;

function collectFailureTexts(error: RuntimeProviderManagementErrorDto): string[] {
  const diagnostics = error.diagnostics;
  return [
    error.message,
    diagnostics?.summary,
    diagnostics?.likelyCause,
    diagnostics?.stderrPreview,
    diagnostics?.stdoutPreview,
    ...(diagnostics?.hints ?? []),
  ].filter((text): text is string => typeof text === 'string' && text.length > 0);
}

function normalizeFailureText(text: string): string {
  return stripTerminalFormatting(text).replace(/\s+/g, ' ');
}

/**
 * True when a connect-api-key response failed specifically because the
 * runtime-side model probe could not verify the provider (as opposed to a
 * rejected key, a missing runtime, or a crashed command).
 */
export function isOpenCodeProviderVerifyFailure(
  response: RuntimeProviderManagementProviderResponse
): boolean {
  if (!response.error || response.provider) {
    return false;
  }
  return collectFailureTexts(response.error).some((text) =>
    VERIFY_FAILURE_PATTERN.test(normalizeFailureText(text))
  );
}
