let contextScopedRequestEpoch = 0;

export function captureContextScopedRequestEpoch(): number {
  return contextScopedRequestEpoch;
}

export function isContextScopedRequestEpochCurrent(epoch: number): boolean {
  return contextScopedRequestEpoch === epoch;
}

export function invalidateContextScopedRequestEpoch(): void {
  contextScopedRequestEpoch += 1;
}

export function resetContextScopedRequestEpochForTests(): void {
  contextScopedRequestEpoch = 0;
}
