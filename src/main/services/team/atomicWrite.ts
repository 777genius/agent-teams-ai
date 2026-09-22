/**
 * Re-export from canonical location.
 * Kept to avoid breaking existing imports — new code should import from @main/utils/atomicWrite.
 */
export { atomicWriteAsync, renamePathWithRetry } from '@main/utils/atomicWrite';
