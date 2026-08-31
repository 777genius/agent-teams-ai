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
 * `CREDENTIAL_REJECTION_PATTERNS` below then vetoes anything that also reads
 * like the provider refusing the credential.
 */
const VERIFY_FAILURE_PATTERN =
  /\b(?:could ?n[o']t|cannot|can ?not|can't|unable to|failed to) verify (?:the )?provider\b/i;

/**
 * Evidence that the provider itself refused the credential, as opposed to a
 * probe that never got to present it. The orchestrator reports a refused probe
 * through `auth-failed` with the provider's own wording, and it also folds
 * per-candidate reasons into the "verify provider ... model candidates" list,
 * so the loose matcher above cannot tell the two apart on its own.
 *
 * A definitive rejection must never reach the commit-then-verify fallback: the
 * runtime already decided the key is bad, so there is nothing to recover. When
 * a failure carries this evidence anywhere, the fallback is refused even if the
 * prose also carries the "verify provider" core — a false refusal only leaves
 * the runtime's original error in place, while a false acceptance would send a
 * rejected key on to be committed.
 */
const CREDENTIAL_REJECTION_PATTERNS: readonly RegExp[] = [
  // "invalid API key", "expired api_key", "revoked x-api-key"
  /\b(?:invalid|incorrect|expired|revoked|rejected|bad|wrong)\b[^.;\n]{0,16}\b(?:x-)?api[\s_-]?key\b/i,
  // "api key is invalid", "API key was rejected"
  /\b(?:x-)?api[\s_-]?key\b[^.;\n]{0,16}\b(?:invalid|incorrect|expired|revoked|rejected|unauthorized)\b/i,
  // "invalid credentials", "invalid bearer token"
  /\binvalid\b[^.;\n]{0,16}\b(?:credentials?|token|bearer|authorization)\b/i,
  // "authentication_error", "authentication failed", "not authenticated"
  /\bauthentication[\s_-]?(?:error|failed|failure)\b/i,
  /\bnot[\s_-]authenticated\b/i,
  /\bpermission[\s_-]denied\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  // Bare HTTP evidence, kept away from version and model-id digits.
  /(?<![\w./-])(?:401|403)(?![\w./-])/,
];

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
  const texts = collectFailureTexts(response.error).map(normalizeFailureText);
  if (texts.some(carriesCredentialRejectionEvidence)) {
    return false;
  }
  return texts.some((text) => VERIFY_FAILURE_PATTERN.test(text));
}

function carriesCredentialRejectionEvidence(text: string): boolean {
  return CREDENTIAL_REJECTION_PATTERNS.some((pattern) => pattern.test(text));
}
