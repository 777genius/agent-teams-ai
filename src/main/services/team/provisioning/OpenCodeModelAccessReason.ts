import { classifyRuntimeDiagnostic } from '../runtime/RuntimeDiagnosticClassifier';
import { redactLaunchFailureArtifactText } from '../TeamLaunchFailureArtifactPack';

import type {
  OpenCodeModelAccessReasonCode,
  TeamProvisioningSupportDiagnostic,
} from '@shared/types';

// A route's own accessKind/providerId is authoritative for whether it needs a
// Go key or a Zen key. The message text only breaks the tie for usage-limit
// responses (e.g. OpenCode's "Free usage exceeded, subscribe to Go"), reusing
// the same classifier as runtime advisories so this does not duplicate a
// second ad hoc keyword list.
export function classifyOpenCodeModelAccessReasonCode(
  route: { providerId?: string | null; accessKind?: string | null; failureCode?: string | null },
  message: string
): OpenCodeModelAccessReasonCode {
  // The runtime's own code wins: it is not a missing or rejected key.
  if (route.failureCode === 'free_tier_restricted') {
    return 'free_tier_restricted';
  }
  if (classifyRuntimeDiagnostic(message).reasonCode === 'quota_exhausted') {
    return 'usage_limit';
  }
  if (route.accessKind === 'execution_failed') {
    // Missing credentials arrive as not_authenticated. execution_failed covers
    // timeouts, outages and tool refusals, so it never proves a bad key.
    return 'unknown';
  }
  if (route.accessKind === 'not_authenticated') {
    const sourceId = route.providerId?.trim().toLowerCase();
    if (sourceId === 'opencode-go') return 'needs_connection_go';
    if (sourceId === 'opencode') return 'needs_connection_zen';
    return 'needs_connection';
  }
  return 'unknown';
}

function getSupportDiagnosticTitle(
  reasonCode: OpenCodeModelAccessReasonCode,
  modelId: string
): string | null {
  if (reasonCode === 'free_tier_restricted') {
    return `OpenCode refused a free-tier request for ${modelId}`;
  }
  return reasonCode === 'unknown' ? `OpenCode could not run ${modelId}` : null;
}

// The preflight UI shows a localized reason, so the runtime's own wording is
// kept here for "Copy diagnostics". Ordinary states such as a provider that is
// not connected or a reached usage limit need no support diagnostic.
export function pushOpenCodeModelAccessSupportDiagnostic(
  target: TeamProvisioningSupportDiagnostic[],
  modelId: string,
  reasonCode: OpenCodeModelAccessReasonCode | undefined,
  rawReason: string
): void {
  const title = reasonCode ? getSupportDiagnosticTitle(reasonCode, modelId) : null;
  if (!reasonCode || !title) return;
  const id = `opencode-model-reason:${modelId}:${reasonCode}`;
  if (target.some((diagnostic) => diagnostic.id === id)) return;
  target.push({
    id,
    providerId: 'opencode',
    kind: 'opencode_model_access_reason',
    severity: 'warning',
    title,
    summary: `Reason code: ${reasonCode}`,
    copyText: redactLaunchFailureArtifactText(
      `model: ${modelId}\nreasonCode: ${reasonCode}\n${rawReason}`
    ),
    createdAt: new Date().toISOString(),
  });
}
