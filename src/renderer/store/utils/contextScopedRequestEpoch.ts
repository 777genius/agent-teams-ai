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

export function invalidateContextScopedRequestEpoch(): void {
  contextScopedRequestEpoch += 1;
  contextScopedRequestEpochStartedAtMs = Date.now();
}

export function resetContextScopedRequestEpochForTests(): void {
  contextScopedRequestEpoch = 0;
  contextScopedRequestEpochStartedAtMs = Date.now();
}
