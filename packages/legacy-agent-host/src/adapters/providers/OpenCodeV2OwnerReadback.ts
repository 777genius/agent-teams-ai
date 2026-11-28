// A stalled native owner can ignore AbortSignal: bound our wait without
// retrying or attesting an uncertain native mutation.
export function awaitOpenCodeV2OwnerReadback<T>(
  invoke: () => Promise<T>, signal: AbortSignal
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('opencode.v2.owner-readback-aborted'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(new Error('opencode.v2.owner-readback-aborted')));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    // Consume both late success and failure; neither can restore readiness.
    try {
      Promise.resolve(invoke()).then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error))
      );
    } catch (error) {
      finish(() => reject(error));
    }
    if (signal.aborted) onAbort();
  });
}
