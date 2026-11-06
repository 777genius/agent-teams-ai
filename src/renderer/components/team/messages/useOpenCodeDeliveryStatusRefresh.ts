import { useEffect } from 'react';

import type { useStore } from '@renderer/store';
import type { OpenCodeRuntimeDeliveryDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';

const REFRESH_DELAYS_MS = [15_000, 45_000, 90_000] as const;

/** Existing bounded delivery observations stop when a visible reply arrives or the source changes. */
export function useOpenCodeDeliveryStatusRefresh(
  teamName: string,
  sendMessageDebugDetails: OpenCodeRuntimeDeliveryDebugDetails | null | undefined,
  sendMessageRuntimeReplyVisible: boolean,
  refreshSendMessageRuntimeDeliveryStatus: ReturnType<
    typeof useStore.getState
  >['refreshSendMessageRuntimeDeliveryStatus']
): void {
  useEffect(() => {
    const debugDetails = sendMessageDebugDetails;
    const messageId = debugDetails?.messageId;
    const shouldPoll =
      debugDetails?.userVisibleState === 'checking' ||
      (!debugDetails?.userVisibleState && debugDetails?.responsePending === true);
    if (!messageId || sendMessageRuntimeReplyVisible || !shouldPoll) {
      return;
    }
    const statusMessageId = debugDetails.statusMessageId || messageId;
    const timers = REFRESH_DELAYS_MS.map((delayMs) =>
      window.setTimeout(() => {
        void refreshSendMessageRuntimeDeliveryStatus(teamName, {
          messageId,
          statusMessageId,
        });
      }, delayMs)
    );
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    refreshSendMessageRuntimeDeliveryStatus,
    sendMessageDebugDetails,
    sendMessageRuntimeReplyVisible,
    teamName,
  ]);
}
