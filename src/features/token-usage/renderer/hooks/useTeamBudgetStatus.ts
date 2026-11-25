import { useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type { TokenUsageBudgetStatusDto } from '../../contracts';

/** One subscription for the entire team list, not one per card. */
export function useTeamBudgetStatus(): TokenUsageBudgetStatusDto | null {
  const [status, setStatus] = useState<TokenUsageBudgetStatusDto | null>(null);
  const lastOrder = useRef<TokenUsageBudgetStatusDto['statusOrder']>(undefined);
  useEffect(() => {
    let alive = true;
    let receivedEvent = false;
    const accept = (next: TokenUsageBudgetStatusDto, fromEvent: boolean): void => {
      if (!alive) return;
      if (fromEvent) receivedEvent = true;
      if (!fromEvent && receivedEvent && !next.statusOrder) return;
      const prior = lastOrder.current;
      if (prior && next.statusOrder?.epoch === prior.epoch &&
          next.statusOrder.sequence <= prior.sequence) return;
      if (prior && !next.statusOrder) return;
      if (next.statusOrder) lastOrder.current = next.statusOrder;
      setStatus(next);
    };
    const unsubscribe = api.tokenUsage.onBudgetStatusChanged((next) => accept(next, true));
    void api.tokenUsage.getBudgetStatus().then((next) => accept(next, false)).catch(() => {
      // A transient status read failure must not fabricate an under-budget state.
    });
    return () => { alive = false; unsubscribe(); };
  }, []);
  return status;
}
