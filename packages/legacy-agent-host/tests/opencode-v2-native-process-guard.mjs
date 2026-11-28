// TEST-only signal boundary shared by the two disposable native harnesses.
// An absent start identity is never an attestation, even if the leader exited.
export function signalCapturedNativeGroup(pid, captured, { readIdentity, present, signal }) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return 'unknown';
  const observed = readIdentity(pid);
  if (typeof captured !== 'string' || !/^\d+$/.test(captured) || observed !== captured) {
    return !present(pid) && !present(-pid) ? 'absent' : 'unknown';
  }
  try { signal(-pid, 'SIGTERM'); }
  catch (error) { if (error?.code !== 'ESRCH') throw error; }
  return 'signalled';
}
