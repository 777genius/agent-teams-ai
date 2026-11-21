import { useEffect } from 'react';

import { useStore } from '@renderer/store';

import { sameExternalAgentRunContext } from '../core/domain/runReadiness';

import type { AppConnectionContext } from '../contracts';

/** Only newly accepted committed changes in this popup's live app/root count. */
export function useManagementApplied(
  open: boolean,
  context: AppConnectionContext | null,
  onApplied?: () => void
): void {
  useEffect(() => {
    if (!open || !context || !onApplied) return;
    const contextId = useStore.getState().activeContextId;
    let delivered = false;
    return useStore.subscribe((state, previous) => {
      if (
        delivered ||
        state.activeContextId !== contextId ||
        previous.activeContextId !== contextId
      )
        return;
      const changed = Object.entries(state.teamManagementNoticeByTeam).some(
        ([team, change]) =>
          change.operationId !== previous.teamManagementNoticeByTeam[team]?.operationId &&
          sameExternalAgentRunContext(change.context, context)
      );
      if (!changed) return;
      delivered = true;
      onApplied();
    });
  }, [context, onApplied, open]);
}
