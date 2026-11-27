let contextScopedRequestEpoch = 0;
let contextScopedRequestEpochStartedAtMs = Date.now();
const epochListeners = new Set<() => void>();

export function subscribeContextScopedRequestEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => { epochListeners.delete(listener); };
}

function notifyEpochListeners(): void {
  for (const listener of epochListeners) listener();
}

export function captureContextScopedRequestEpoch(): number {
  return contextScopedRequestEpoch;
}

export function captureContextScopedRequestEpochStartedAtMs(): number {
  return contextScopedRequestEpochStartedAtMs;
}

export function isContextScopedRequestEpochCurrent(epoch: number): boolean {
  return contextScopedRequestEpoch === epoch;
}

export function invalidateContextScopedRequestEpoch(): void {
  contextScopedRequestEpoch += 1;
  contextScopedRequestEpochStartedAtMs = Date.now();
  notifyEpochListeners();
}

export function resetContextScopedRequestEpochForTests(): void {
  contextScopedRequestEpoch = 0;
  contextScopedRequestEpochStartedAtMs = Date.now();
}
