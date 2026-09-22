import { useEffect, useLayoutEffect, useRef } from 'react';

/** Passive refresh starts only after bootstrap and survives unrelated status polling. */
export function useDashboardStatusRefresh(enabled: boolean, refresh: () => void): void {
  const latestRefresh = useRef(refresh);
  useLayoutEffect(() => {
    latestRefresh.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => latestRefresh.current(), 10 * 60_000);
    return () => clearInterval(timer);
  }, [enabled]);
}
