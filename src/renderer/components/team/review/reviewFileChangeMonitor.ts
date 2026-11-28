import type { ConflictCheckResult } from '@shared/types';

export interface ReviewWriteExpectation {
  expectedContent: string | null;
}

interface ReviewFileChangeOptions {
  isCurrent: () => boolean;
  isWriteInFlight: () => boolean;
  getExpectedWrite: () => ReviewWriteExpectation | undefined;
  forgetExpectedWrite: () => void;
  waitForWrite: () => Promise<void>;
  checkConflict: (expectedContent: string) => Promise<ConflictCheckResult>;
  onExternalChange: () => void;
}

/** Classify a notification against the review mutation's expected disk bytes. */
export async function handleReviewFileChange(options: ReviewFileChangeOptions): Promise<void> {
  while (options.isCurrent()) {
    if (options.isWriteInFlight()) {
      await options.waitForWrite();
      continue;
    }
    const expected = options.getExpectedWrite();
    if (!expected) {
      options.onExternalChange();
      return;
    }
    let matchesExpected = false;
    try {
      // Native watcher delivery and Host authorization can outlive a time-based
      // cooldown. Only an authorized disk read can establish the current bytes.
      const result = await options.checkConflict(expected.expectedContent ?? '');
      matchesExpected =
        expected.expectedContent === null
          ? result.hasConflict && result.conflictContent === null
          : !result.hasConflict;
    } catch {
      // Failed verification is not evidence of an own write.
    }
    if (!options.isCurrent()) return;
    // A second review mutation may have started or committed while the disk
    // check awaited IPC. Its postimage must be checked before using this result.
    if (options.isWriteInFlight() || options.getExpectedWrite() !== expected) continue;
    if (matchesExpected) return;
    options.forgetExpectedWrite();
    options.onExternalChange();
    return;
  }
}
