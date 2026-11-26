import { useEffect, useState } from 'react';

import { api } from '@renderer/api';

import type { TokenUsageBudgetStatusDto } from '../../contracts';

/** One subscription for the entire team list, not one per card. */
export function useTeamBudgetStatus(): TokenUsageBudgetStatusDto | null {
  const [status, setStatus] = useState<TokenUsageBudgetStatusDto | null>(null);
  useEffect(() => {
    let alive = true;
    let current: TokenUsageBudgetStatusDto | null = null;
    let reading = false;
    const pending = new Map<string, TokenUsageBudgetStatusDto>();

    const accept = (next: TokenUsageBudgetStatusDto): void => {
      if (!alive) return;
      const prior = current?.statusOrder;
      const order = next.statusOrder;
      if (prior && !order) return;
      if (prior && order?.epoch === prior.epoch && order.sequence <= prior.sequence) return;
      current = next;
      setStatus(next);
    };

    // Epoch UUIDs are opaque. Only a current status read can establish a new
    // epoch; events can advance its sequence, but cannot replace it by arrival order.
    const refresh = async (): Promise<void> => {
      if (reading || !alive) return;
      reading = true;
      let refreshAgain = false;
      try {
        const next = await api.tokenUsage.getBudgetStatus();
        if (!alive) return;
        accept(next);
        const epoch = current?.statusOrder?.epoch;
        const buffered = epoch === undefined ? undefined : pending.get(epoch);
        if (buffered) accept(buffered);
        // Another epoch appeared while the read was in flight. A second read
        // settles that race without guessing which producer was newer.
        refreshAgain = [...pending.keys()].some((key) => key !== epoch);
      } catch {
        // A transient status read failure must not fabricate an under-budget state.
      } finally {
        pending.clear();
        reading = false;
        if (refreshAgain && alive) void refresh();
      }
    };

    const unsubscribe = api.tokenUsage.onBudgetStatusChanged((next) => {
      if (!alive) return;
      const order = next.statusOrder;
      if (!order || order.epoch === current?.statusOrder?.epoch) {
        accept(next);
        return;
      }
      if (reading) {
        const buffered = pending.get(order.epoch)?.statusOrder;
        if (!buffered || order.sequence > buffered.sequence) pending.set(order.epoch, next);
      } else {
        // The read starts after this event and is authoritative for its epoch.
        void refresh();
      }
    });
    void refresh();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return status;
}
