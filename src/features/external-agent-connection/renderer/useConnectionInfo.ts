import { useCallback, useEffect, useRef, useState } from 'react';

import type { ConnectionInfoV1, ExternalAgentConnectionApi } from '../contracts';

/** Reads live discovery without starting resources; retry is an explicit user action. */
export function useConnectionInfo(api: ExternalAgentConnectionApi, enabled: boolean) {
  const [info, setInfo] = useState<ConnectionInfoV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setInfo(null);
    setError(null);
    if (!enabled) return;
    const read = async (): Promise<void> => {
      try {
        const next = await api.getConnectionInfo();
        if (generation.current !== current) return;
        setInfo(next);
        setError(null);
      } catch (cause) {
        if (generation.current !== current) return;
        setInfo(null);
        setError(cause instanceof Error ? cause.message : 'Cannot read app connection.');
      }
      if (generation.current === current) timer = setTimeout(() => void read(), 5000);
    };
    void read();
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [api, enabled]);

  const retry = useCallback(async (): Promise<void> => {
    if (!enabled || retrying) return;
    const current = generation.current;
    setRetrying(true);
    setError(null);
    try {
      const next = await api.retryConnection();
      if (generation.current === current) setInfo(next);
    } catch (cause) {
      if (generation.current === current) {
        setInfo(null);
        setError(cause instanceof Error ? cause.message : 'Cannot retry app connection.');
      }
    } finally {
      setRetrying(false);
    }
  }, [api, enabled, retrying]);

  return { info, error, retrying, retry };
}
