import { useCallback } from 'react';

import { normalizePathForComparison } from '@shared/utils/platformPath';

import { useChangeReviewExternalFileWatcher } from './useChangeReviewExternalFileWatcher';

import type {
  ChangeReviewExternalFileWatcherPort,
  ChangeReviewRecentWrite,
} from '../ports/changeReviewDialogInteractionPorts';
import type {
  ChangeReviewExternalChangePolicy,
  ChangeReviewExternalChangeStatePort,
} from '../ports/changeReviewMutationSafetyPorts';
import type { ReviewDraftHistoryEntry } from '@features/change-review-history/contracts';
import type { EditorFileChangeEvent, ReviewFileScope } from '@shared/types';
import type { RefObject } from 'react';

interface UseChangeReviewExternalChangeControllerInput {
  open: boolean;
  enabled: boolean;
  projectPath: string | undefined;
  watchedFilePathsKey: string;
  reviewScope: ReviewFileScope;
  externalChangesByFile: Readonly<Record<string, unknown>>;
  recentWritesRef: RefObject<Map<string, ChangeReviewRecentWrite>>;
  isMutationInFlight: (normalizedPath: string) => boolean;
  getDraftHistoryEntry: (filePath: string) => ReviewDraftHistoryEntry | undefined;
  statePort: ChangeReviewExternalChangeStatePort;
  policy: ChangeReviewExternalChangePolicy;
  watcherPort: ChangeReviewExternalFileWatcherPort;
}

export interface ChangeReviewExternalChangeController {
  reviewMutationBlockedByExternalChange: boolean;
  blockReviewMutationForExternalChange: (filePath?: string) => boolean;
}

export function useChangeReviewExternalChangeController({
  open,
  enabled,
  projectPath,
  watchedFilePathsKey,
  reviewScope,
  externalChangesByFile,
  recentWritesRef,
  isMutationInFlight,
  getDraftHistoryEntry,
  statePort,
  policy,
  watcherPort,
}: UseChangeReviewExternalChangeControllerInput): ChangeReviewExternalChangeController {
  const reviewMutationBlockedByExternalChange = Object.keys(externalChangesByFile).length > 0;
  const blockReviewMutationForExternalChange = useCallback(
    (filePath?: string): boolean => {
      const externalChanges = statePort.getSnapshot().reviewExternalChangesByFile;
      const blocked = filePath
        ? policy.hasUnresolvedExternalChange(filePath, externalChanges)
        : Object.keys(externalChanges).length > 0;
      if (blocked) {
        statePort.reportError(
          'Reload files changed outside Changes before continuing review actions.'
        );
      }
      return blocked;
    },
    [policy, statePort]
  );
  const processExternalChange = useCallback(
    (event: EditorFileChangeEvent): void => {
      const normalizedPath = normalizePathForComparison(event.path);
      const state = statePort.getSnapshot();
      const file = state.activeChangeSet?.files.find(
        (entry) => normalizePathForComparison(entry.filePath) === normalizedPath
      );
      if (!file) return;
      const durableDraftHistory = getDraftHistoryEntry(file.filePath);
      if (!(file.filePath in state.editedContents) && durableDraftHistory) {
        statePort.restoreDraft(file.filePath, durableDraftHistory.editorState.doc);
      }
      const changeType =
        event.type === 'create' ? 'add' : event.type === 'delete' ? 'unlink' : 'change';
      statePort.markExternalChange(file.filePath, changeType);
      statePort.reportError(
        'A reviewed file changed outside Changes. Reload it from disk before continuing review actions.'
      );
    },
    [getDraftHistoryEntry, statePort]
  );

  useChangeReviewExternalFileWatcher({
    open,
    enabled,
    projectPath,
    watchedFilePathsKey,
    reviewScope,
    recentWritesRef,
    isMutationInFlight,
    processExternalChange,
    port: watcherPort,
  });

  return {
    reviewMutationBlockedByExternalChange,
    blockReviewMutationForExternalChange,
  };
}
