const listeners = new Set<() => void>();
let contextScopedRequestEpoch = 0;
let contextScopedRequestEpochStartedAtMs = Date.now();

export function captureContextScopedRequestEpoch(): number {
  return contextScopedRequestEpoch;
}

export function captureContextScopedRequestEpochStartedAtMs(): number {
  return contextScopedRequestEpochStartedAtMs;
}

export function isContextScopedRequestEpochCurrent(epoch: number): boolean {
  return contextScopedRequestEpoch === epoch;
}

export function subscribeContextScopedRequestEpoch(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function invalidateContextScopedRequestEpoch(): void {
  contextScopedRequestEpoch += 1;
  contextScopedRequestEpochStartedAtMs = Date.now();
  for (const listener of listeners) listener();
}

export function resetContextScopedRequestEpochForTests(): void {
  contextScopedRequestEpoch = 0;
  contextScopedRequestEpochStartedAtMs = Date.now();
  for (const listener of listeners) listener();
}
