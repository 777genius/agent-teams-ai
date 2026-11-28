// Give each wait its own removable abort listener. Racing every native event
// against one shared unresolved revocation Promise retains reactions forever.
export async function raceOpenCodeV2Revocation<T>(
  operation: Promise<T>, signal: AbortSignal
): Promise<{ kind: 'event'; value: T } | { kind: 'revoked' }> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return { kind: 'revoked' };
  }
  let onAbort!: () => void;
  const revoked = new Promise<{ kind: 'revoked' }>((resolve) => {
    onAbort = () => resolve({ kind: 'revoked' });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([
      operation.then(value => ({ kind: 'event' as const, value })), revoked,
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
