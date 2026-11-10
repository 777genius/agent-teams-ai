/**
 * Re-export from canonical location.
 * Kept to avoid breaking existing imports — new code should import from @main/utils/atomicWrite.
 */
export { atomicWriteAsync, renamePathWithRetry } from '@main/utils/atomicWrite';

import {
  atomicWriteAsync as writeAtomicAsync,
  type AtomicWriteOptions,
} from '@main/utils/atomicWrite';

/** Inbox state must remain private even when the host's umask allows group writes. */
export function atomicWriteInboxAsync(
  targetPath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  return writeAtomicAsync(targetPath, data, { ...options, mode: 0o600, directoryMode: 0o700 });
}
