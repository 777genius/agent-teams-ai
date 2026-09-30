import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { ConflictCheckResult, EditorFileChangeEvent, ReviewFileScope } from '@shared/types';

export interface ChangeReviewCollapsedFilesStoragePort {
  read: (storageKey: string) => Set<string>;
  write: (storageKey: string, filePaths: ReadonlySet<string>) => void;
}

export interface ChangeReviewRecentWrite {
  at: number;
  expectedContent: string | null;
}

export interface ChangeReviewExternalFileWatcherPort {
  checkConflict: (
    scope: ReviewFileScope,
    filePath: string,
    expectedModified: string
  ) => Promise<ConflictCheckResult>;
  subscribe: (callback: (event: EditorFileChangeEvent) => void) => () => void;
  watchFiles: (projectPath: string, filePaths: string[]) => Promise<void>;
  unwatchFiles: () => Promise<void>;
}

export interface ChangeReviewDialogKeyboardInteractionPort {
  subscribeRejectCurrentHunk: (callback: () => void) => (() => void) | undefined;
  rejectCurrentChunk: (
    filePath: string
  ) => { hunkIndex: number; beforeContent: string; afterContent: string } | null;
  rollbackContent: (filePath: string, content: string) => void;
}

export interface ChangeReviewDialogEditorActions {
  acceptAllChunks: (view: EditorView) => boolean;
  computeChunkIndexAtPosition: (state: EditorState, position: number) => number;
  ignoreNextDocChange: (view: EditorView) => void;
  rejectAllChunks: (view: EditorView) => boolean;
  rejectChunk: (view: EditorView) => boolean;
}
