import { sanitizeRuntimeDiagnosticText } from '@shared/utils/runtimeDiagnosticText';

import type { CliExternalRuntimeDiagnostic, CliProviderStatus } from '@shared/types';

const FAILURE_MESSAGE = /\b(?:error|failed|failure|unavailable|timeout|timed out|cannot|could not|denied|invalid)\b/i;

export function hasTopLevelOpenCodeFailure(provider: CliProviderStatus): boolean {
  return (
    provider.verificationState === 'error' ||
    provider.verificationState === 'offline' ||
    provider.statusCheckOutcome === 'transient_error' ||
    (provider.statusCheckErrorCode != null &&
      provider.statusCheckErrorCode !== 'partial_response') ||
    provider.modelCatalogRefreshState === 'error' ||
    (provider.statusCheckOutcome !== 'pending' &&
      FAILURE_MESSAGE.test(provider.statusMessage ?? ''))
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
  return (provider.externalRuntimeDiagnostics ?? [])
    .filter(isFailureDiagnostic)
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
    (hasTopLevelOpenCodeFailure(provider) ||
      (provider.externalRuntimeDiagnostics ?? []).some(isFailureDiagnostic))
  );
}

/** Share the tested, renderer-safe runtime sanitizer; never truncate before redaction. */
export function sanitizeOpenCodeStatusText(value: string): string {
  return sanitizeRuntimeDiagnosticText(value, 500) ?? '';
}
