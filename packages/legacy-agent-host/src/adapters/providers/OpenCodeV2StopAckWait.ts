// A missing native stop ACK can stay pending forever. A timeout only ends
// this wait; it never grants physical custody or authorizes another signal.
const NATIVE_STOP_ACK_WAIT_MS = 2_000;

export async function waitForNativeStopResult(pending: Promise<boolean>): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<boolean>(resolve => {
        timeout = setTimeout(() => resolve(false), NATIVE_STOP_ACK_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
