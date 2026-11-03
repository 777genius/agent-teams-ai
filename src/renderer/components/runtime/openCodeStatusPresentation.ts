import type { CliExternalRuntimeDiagnostic, CliProviderStatus } from '@shared/types';

const FAILURE_MESSAGE = /\b(?:error|failed|failure|unavailable|timeout|timed out|cannot|could not|denied|invalid)\b/i;

function hasTopLevelFailure(provider: CliProviderStatus): boolean {
  return (
    provider.verificationState === 'error' ||
    provider.verificationState === 'offline' ||
    provider.statusCheckOutcome === 'transient_error' ||
    (provider.statusCheckErrorCode != null &&
      provider.statusCheckErrorCode !== 'partial_response') ||
    provider.modelCatalogRefreshState === 'error'
  );
}

function isFailureDiagnostic(diagnostic: CliExternalRuntimeDiagnostic): boolean {
  return FAILURE_MESSAGE.test(
    `${diagnostic.statusMessage ?? ''} ${diagnostic.detailMessage ?? ''}`
  );
}

/** Do not surface optional/missing probes or passive inventory as a runtime failure. */
export function getActionableOpenCodeDiagnostics(
  provider: CliProviderStatus
): readonly CliExternalRuntimeDiagnostic[] {
  if (provider.providerId !== 'opencode') return [];
  const topLevelFailure = hasTopLevelFailure(provider);
  return (provider.externalRuntimeDiagnostics ?? [])
    .filter((diagnostic) =>
      isFailureDiagnostic(diagnostic) || (topLevelFailure && !diagnostic.detected)
    )
    .map((diagnostic) => ({
      ...diagnostic,
      label: sanitizeOpenCodeStatusText(diagnostic.label),
      statusMessage: diagnostic.statusMessage
        ? sanitizeOpenCodeStatusText(diagnostic.statusMessage)
        : diagnostic.statusMessage,
      detailMessage: diagnostic.detailMessage
        ? sanitizeOpenCodeStatusText(diagnostic.detailMessage)
        : diagnostic.detailMessage,
    }));
}

export function hasActionableOpenCodeStatusIssue(provider: CliProviderStatus): boolean {
  return (
    provider.providerId === 'opencode' &&
    (hasTopLevelFailure(provider) ||
      (provider.externalRuntimeDiagnostics ?? []).some(isFailureDiagnostic))
  );
}

/** Safety-net for diagnostic text received from external CLI processes. */
export function sanitizeOpenCodeStatusText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_-]{12,}|github_pat_[a-z0-9_]{12,})\b/gi, '[redacted]')
    .replace(/(\b(?:authorization|bearer|token|api[_ -]?key|password|secret)\b\s*[:=]\s*)[^\s&]+/gi, '$1[redacted]')
    .slice(0, 500);
}
