import { isTransientFsErrorCode } from '@main/utils/transientFsRetry';

export const INBOX_WRITE_ATTEMPTS = 3;

/**
 * A live teammate can hold the Windows inbox target open beyond atomic
 * rename's own retry window. Retry with a fresh read/modify/write transaction
 * and the same messageId; never republish the stale serialized snapshot.
 */
export async function waitForTransientInboxWrite(
  error: unknown,
  attempt: number
): Promise<boolean> {
  if (
    attempt >= INBOX_WRITE_ATTEMPTS - 1 ||
    !isTransientFsErrorCode((error as NodeJS.ErrnoException)?.code)
  ) {
    return false;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 125 * (attempt + 1)));
  return true;
}
