import { useCallback, useEffect, useRef, useState } from 'react';

import type { ConnectionInfoV1, ExternalAgentConnectionApi } from '../contracts';

/** Reads live discovery without starting resources; retry is an explicit user action. */
export function useConnectionInfo(api: ExternalAgentConnectionApi, enabled: boolean) {
  const [info, setInfo] = useState<ConnectionInfoV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const generation = useRef(0);
  const retryCurrent = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestId = 0;
    let retryActive = false;
    setInfo(null);
    setError(null);
    setRetrying(false);
    if (!enabled) return;
    const isCurrent = (id: number): boolean => generation.current === current && requestId === id;
    const scheduleRead = (): void => {
      timer = setTimeout(() => void read(), 5000);
    };
    const read = async (): Promise<void> => {
      const id = ++requestId;
      try {
        const next = await api.getConnectionInfo();
        if (!isCurrent(id)) return;
        setInfo(next);
        setError(null);
      } catch (cause) {
        if (!isCurrent(id)) return;
        setInfo(null);
        setError(cause instanceof Error ? cause.message : 'Cannot read app connection.');
      }
      if (isCurrent(id)) scheduleRead();
    };
    retryCurrent.current = async (): Promise<void> => {
      if (retryActive || generation.current !== current) return;
      retryActive = true;
      clearTimeout(timer);
      const id = ++requestId;
      setRetrying(true);
      setError(null);
      try {
        const next = await api.retryConnection();
        if (!isCurrent(id)) return;
        setInfo(next);
        setError(null);
      } catch (cause) {
        if (!isCurrent(id)) return;
        setInfo(null);
        setError(cause instanceof Error ? cause.message : 'Cannot retry app connection.');
      } finally {
        if (isCurrent(id)) {
          retryActive = false;
          setRetrying(false);
          scheduleRead();
        }
      }
    };
    void read();
    return () => {
      generation.current++;
      retryCurrent.current = null;
      clearTimeout(timer);
    };
  }, [api, enabled]);

  const retry = useCallback(async (): Promise<void> => {
    await retryCurrent.current?.();
  }, []);

  return { info, error, retrying, retry };
}
