import { useEffect, useRef } from 'react';

import { normalizePathForComparison } from '@shared/utils/platformPath';

import type {
  ChangeReviewExternalFileWatcherPort,
  ChangeReviewRecentWrite,
} from '../ports/changeReviewDialogInteractionPorts';
import type { EditorFileChangeEvent, ReviewFileScope } from '@shared/types';
import type { RefObject } from 'react';

const REVIEW_LOCAL_WRITE_COOLDOWN_MS = 2000;
const REVIEW_WRITE_SETTLE_RETRY_MS = 25;

interface UseChangeReviewExternalFileWatcherInput {
  open: boolean;
  enabled: boolean;
  projectPath: string | undefined;
  watchedFilePathsKey: string;
  reviewScope: ReviewFileScope;
  recentWritesRef: RefObject<Map<string, ChangeReviewRecentWrite>>;
  isMutationInFlight: (normalizedPath: string) => boolean;
  processExternalChange: (event: EditorFileChangeEvent) => void;
  port: ChangeReviewExternalFileWatcherPort;
}

interface VerifyExpectedReviewWriteInput {
  event: EditorFileChangeEvent;
  normalizedPath: string;
  reviewScope: ReviewFileScope;
  recentWritesRef: RefObject<Map<string, ChangeReviewRecentWrite>>;
  isDisposed: () => boolean;
  isMutationInFlight: (normalizedPath: string) => boolean;
  processIfCurrent: () => void;
  port: ChangeReviewExternalFileWatcherPort;
}

async function verifyExpectedReviewWrite(input: VerifyExpectedReviewWriteInput): Promise<void> {
  if (input.isDisposed()) return;
  if (input.isMutationInFlight(input.normalizedPath)) {
    setTimeout(() => void verifyExpectedReviewWrite(input), REVIEW_WRITE_SETTLE_RETRY_MS);
    return;
  }
  const latest = input.recentWritesRef.current.get(input.normalizedPath);
  if (!latest) return;
  try {
    const result = await input.port.checkConflict(
      input.reviewScope,
      input.event.path,
      latest.expectedContent ?? ''
    );
    const matchesExpected =
      latest.expectedContent === null
        ? result.hasConflict && result.conflictContent === null
        : !result.hasConflict;
    if (matchesExpected) return;
  } catch {
    // A failed verification is not evidence that this was our own event.
  }
  input.recentWritesRef.current.delete(input.normalizedPath);
  input.processIfCurrent();
}

export function useChangeReviewExternalFileWatcher({
  open,
  enabled,
  projectPath,
  watchedFilePathsKey,
  reviewScope,
  recentWritesRef,
  isMutationInFlight,
  processExternalChange,
  port,
}: UseChangeReviewExternalFileWatcherInput): void {
  const watchedFilePathsKeyRef = useRef(watchedFilePathsKey);
  useEffect(() => {
    watchedFilePathsKeyRef.current = watchedFilePathsKey;
  }, [watchedFilePathsKey]);

  useEffect(() => {
    if (!open || !projectPath || !enabled) return;
    let disposed = false;

    const unsubscribe = port.subscribe((event) => {
      const normalizedPath = normalizePathForComparison(event.path);
      const processIfCurrent = (): void => {
        if (!disposed) processExternalChange(event);
      };
      const recentWrite = recentWritesRef.current.get(normalizedPath);
      if (!recentWrite || Date.now() - recentWrite.at >= REVIEW_LOCAL_WRITE_COOLDOWN_MS) {
        processIfCurrent();
        return;
      }
      void verifyExpectedReviewWrite({
        event,
        normalizedPath,
        reviewScope,
        recentWritesRef,
        isDisposed: () => disposed,
        isMutationInFlight,
        processIfCurrent,
        port,
      });
    });

    const initialFilePaths = watchedFilePathsKeyRef.current
      ? watchedFilePathsKeyRef.current.split('\0')
      : [];
    void port.watchFiles(projectPath, initialFilePaths);

    return () => {
      disposed = true;
      unsubscribe();
      void port.unwatchFiles();
    };
  }, [
    enabled,
    isMutationInFlight,
    open,
    port,
    processExternalChange,
    projectPath,
    recentWritesRef,
    reviewScope,
  ]);

  useEffect(() => {
    if (!open || !projectPath || !enabled) return;
    const filePaths = watchedFilePathsKey ? watchedFilePathsKey.split('\0') : [];
    void port.watchFiles(projectPath, filePaths);
  }, [enabled, open, port, projectPath, watchedFilePathsKey]);
}
