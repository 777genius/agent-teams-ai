import type { SendMessageResult } from '@shared/types';

export interface OpenCodeRuntimeDeliveryDebugDetails {
  messageId: string;
  providerId: string;
  delivered: boolean | null;
  responsePending: boolean | null;
  responseState: string | null;
  ledgerStatus: string | null;
  acceptanceUnknown: boolean | null;
  reason: string | null;
  diagnostics: string[];
}

interface OpenCodeRuntimeDeliveryDiagnostics {
  warning: string | null;
  debugDetails: OpenCodeRuntimeDeliveryDebugDetails | null;
}

const PENDING_WARNING =
  'OpenCode runtime delivery is still being checked. Message was saved and will be retried if needed.';
const FAILED_WARNING =
  'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete.';

export function buildOpenCodeRuntimeDeliveryDiagnostics(
  result: SendMessageResult
): OpenCodeRuntimeDeliveryDiagnostics {
  const runtimeDelivery = result.runtimeDelivery;
  if (!runtimeDelivery || runtimeDelivery.attempted !== true) {
    return { warning: null, debugDetails: null };
  }

  const isFailed = runtimeDelivery.delivered === false;
  const isPending = runtimeDelivery.responsePending === true;
  if (!isFailed && !isPending) {
    return { warning: null, debugDetails: null };
  }

  return {
    warning: isFailed ? FAILED_WARNING : PENDING_WARNING,
    debugDetails: {
      messageId: result.messageId,
      providerId: runtimeDelivery.providerId,
      delivered: typeof runtimeDelivery.delivered === 'boolean' ? runtimeDelivery.delivered : null,
      responsePending:
        typeof runtimeDelivery.responsePending === 'boolean'
          ? runtimeDelivery.responsePending
          : null,
      responseState: runtimeDelivery.responseState ?? null,
      ledgerStatus: runtimeDelivery.ledgerStatus ?? null,
      acceptanceUnknown:
        typeof runtimeDelivery.acceptanceUnknown === 'boolean'
          ? runtimeDelivery.acceptanceUnknown
          : null,
      reason: runtimeDelivery.reason ?? null,
      diagnostics: runtimeDelivery.diagnostics ?? [],
    },
  };
}

export function formatOpenCodeRuntimeDeliveryDebugDetails(
  details: OpenCodeRuntimeDeliveryDebugDetails
): string {
  return JSON.stringify(
    {
      messageId: details.messageId,
      providerId: details.providerId,
      delivered: details.delivered,
      responsePending: details.responsePending,
      responseState: details.responseState,
      ledgerStatus: details.ledgerStatus,
      acceptanceUnknown: details.acceptanceUnknown,
      reason: details.reason,
      diagnostics: details.diagnostics,
    },
    null,
    2
  );
}
