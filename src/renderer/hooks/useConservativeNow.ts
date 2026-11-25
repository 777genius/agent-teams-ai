import { useCallback, useLayoutEffect, useReducer } from 'react';

interface ConservativeClockSnapshot {
  source: unknown;
  now: number;
}

/** Revalidates each source before paint without reading the clock during render. */
export function useConservativeNow(source: unknown): readonly [number, (now: number) => void] {
  const [snapshot, publishSnapshot] = useReducer(
    (_current: ConservativeClockSnapshot, next: ConservativeClockSnapshot) => next,
    { source: null, now: Number.POSITIVE_INFINITY }
  );
  const publishNow = useCallback((now: number) => publishSnapshot({ source, now }), [source]);

  useLayoutEffect(() => {
    publishNow(Date.now());
  }, [publishNow]);

  return [Object.is(snapshot.source, source) ? snapshot.now : Number.POSITIVE_INFINITY, publishNow];
}
