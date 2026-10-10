import { sanitizeRuntimeDiagnosticText } from '@shared/utils/runtimeDiagnosticText';

import type { ProvisioningProviderCheck } from './provisioningProviderChecks';

/** Makes failed status checks shareable even before a launch diagnostic pack exists. */
export function getSupportDiagnosticsPayload(check: ProvisioningProviderCheck): string | null {
  if (check.providerId !== 'opencode') return null;
  const prepared = (check.supportDiagnostics ?? [])
    .map((diagnostic) => diagnostic.copyText.trim())
    .filter(Boolean);
  if (prepared.length > 0) {
    return sanitizeRuntimeDiagnosticText(prepared.join('\n\n---\n\n'), 12_000) ?? null;
  }
  if (check.status !== 'failed' || !check.details.some((detail) => detail.trim())) return null;
  const lines = [
    'Agent Teams OpenCode preflight diagnostics',
    `Provider: ${check.providerId}`,
    `Status: ${check.status}`,
    ...(check.backendSummary ? [`Backend: ${check.backendSummary}`] : []),
    ...check.details,
  ].flatMap((detail) => detail.split(/\r?\n/));
  return sanitizeRuntimeDiagnosticText(lines.join('\n'), 12_000) ?? null;
}
