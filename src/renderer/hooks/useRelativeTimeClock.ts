import { useSyncExternalStore } from 'react';

const RELATIVE_TIME_TICK_MS = 30_000;

const listeners = new Set<() => void>();
let intervalId: number | null = null;

function emitTick(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (intervalId === null) {
    intervalId = window.setInterval(emitTick, RELATIVE_TIME_TICK_MS);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function subscribeDisabled(): () => void {
  return () => undefined;
}

function getSnapshot(): number {
  return Math.floor(Date.now() / RELATIVE_TIME_TICK_MS);
}

function getDisabledSnapshot(): number {
  return 0;
}

/** Returns a stable shared clock snapshot while relative timestamps are visible. */
export function useRelativeTimeClock(enabled: boolean): number {
  const tick = useSyncExternalStore(
    enabled ? subscribe : subscribeDisabled,
    enabled ? getSnapshot : getDisabledSnapshot,
    getDisabledSnapshot
  );
  return tick * RELATIVE_TIME_TICK_MS;
}
