import { useCallback, useMemo, useState } from 'react';

import type { ComposerSubmissionResult } from './composerSubmission';
import type { OpenCodeRuntimeDeliveryDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import type { SendMessageResult } from '@shared/types';

interface ComposerSubmissionFeedback {
  readonly submissionError: string | null;
  readonly sendWarning: string | null;
  readonly sendDebugDetails: OpenCodeRuntimeDeliveryDebugDetails | null;
  readonly deduplicated: boolean;
  readonly record: (addressKey: string, result: ComposerSubmissionResult) => void;
}

export function useComposerSubmissionFeedback(
  addressKey: string,
  sendWarning: string | null | undefined,
  sendDebugDetails: OpenCodeRuntimeDeliveryDebugDetails | null | undefined,
  lastResult: SendMessageResult | null | undefined
): ComposerSubmissionFeedback {
  const [feedback, setFeedback] = useState<{
    readonly addressKey: string;
    readonly result: ComposerSubmissionResult;
  } | null>(null);
  const record = useCallback((nextAddressKey: string, result: ComposerSubmissionResult) => {
    setFeedback({ addressKey: nextAddressKey, result });
  }, []);

  return useMemo(() => {
    const current = feedback?.addressKey === addressKey ? feedback.result : null;
    const messageId = current?.messageId;
    const matchingDebug =
      messageId && sendDebugDetails?.messageId === messageId ? sendDebugDetails : null;
    const matchingLast = messageId && lastResult?.messageId === messageId ? lastResult : null;
    return {
      submissionError:
        current?.kind === 'unconfirmed' || current?.kind === 'not-sent'
          ? (current.detail ?? 'Delivery was not positively confirmed.')
          : null,
      sendWarning: matchingDebug ? (sendWarning ?? null) : null,
      sendDebugDetails: matchingDebug,
      deduplicated: current?.deduplicated === true || matchingLast?.deduplicated === true,
      record,
    };
  }, [addressKey, feedback, lastResult, record, sendDebugDetails, sendWarning]);
}
