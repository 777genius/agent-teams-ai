let epoch = 0;
const listeners = new Set<() => void>();

export const capturePrMonitorAuthorityEpoch = (): number => epoch;

export function subscribePrMonitorAuthorityEpoch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Native account changes invalidate every mounted monitor, including inactive tabs. */
export function invalidatePrMonitorAuthority(): void {
  epoch++;
  for (const listener of listeners) listener();
}
