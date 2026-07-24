import { useCallback, useEffect, useMemo } from 'react';

import { useDiffNavigation } from '@renderer/hooks/useDiffNavigation';

import { useChangeReviewHistoryKeyboardShortcuts } from './useChangeReviewHistoryKeyboardShortcuts';

import type { ChangeReviewDialogKeyboardInteractionPort } from '../ports/changeReviewDialogInteractionPorts';
import type { EditorView } from '@codemirror/view';
import type { FileChangeSummary, ReviewRedoAction, ReviewUndoAction } from '@shared/types';
import type { RefObject } from 'react';

interface UseChangeReviewDialogKeyboardInteractionsInput {
  open: boolean;
  activeFilePath: string | null;
  activeFilePathRef: RefObject<string | null>;
  activeEditorViewRef: RefObject<EditorView | null>;
  editorViewMapRef: RefObject<Map<string, EditorView>>;
  sortedFiles: FileChangeSummary[];
  fileChunkCounts: Record<string, number>;
  editedCount: number;
  scrollToFile: (filePath: string) => void;
  saveFile: (filePath: string) => Promise<void>;
  requestClose: () => Promise<void>;
  acceptHunk: (filePath: string, hunkIndex: number) => boolean | void;
  rejectHunk: (
    filePath: string,
    hunkIndex: number,
    beforeContent: string,
    afterContent: string
  ) => boolean | void;
  hasDraft: (filePath: string) => boolean;
  hasActionInFlight: () => boolean;
  getEditorFilePathForTarget: (target: Element | null) => string | null;
  getHunkCountForFile: (
    filePath: string,
    fallbackSnippetsLength: number,
    fileChunkCounts: Record<string, number>
  ) => number;
  getUndoHistory: () => ReviewUndoAction[];
  getRedoHistory: () => ReviewRedoAction[];
  undoLatest: () => Promise<void>;
  redoLatest: () => Promise<void>;
  reportError: (message: string) => void;
  keyboardPort: ChangeReviewDialogKeyboardInteractionPort;
}

export interface ChangeReviewDialogKeyboardInteractions {
  diffNav: ReturnType<typeof useDiffNavigation>;
  reviewHunkOrder: {
    offsets: Record<string, number>;
    total: number;
  };
}

export function useChangeReviewDialogKeyboardInteractions({
  open,
  activeFilePath,
  activeFilePathRef,
  activeEditorViewRef,
  editorViewMapRef,
  sortedFiles,
  fileChunkCounts,
  editedCount,
  scrollToFile,
  saveFile,
  requestClose,
  acceptHunk,
  rejectHunk,
  hasDraft,
  hasActionInFlight,
  getEditorFilePathForTarget,
  getHunkCountForFile,
  getUndoHistory,
  getRedoHistory,
  undoLatest,
  redoLatest,
  reportError,
  keyboardPort,
}: UseChangeReviewDialogKeyboardInteractionsInput): ChangeReviewDialogKeyboardInteractions {
  const getHunkCount = useCallback(
    (filePath: string, fallbackSnippetsLength: number): number =>
      getHunkCountForFile(filePath, fallbackSnippetsLength, fileChunkCounts),
    [fileChunkCounts, getHunkCountForFile]
  );
  const handleSaveActiveFile = useCallback((): void => {
    if (!activeFilePath || hasActionInFlight()) return;
    void saveFile(activeFilePath);
  }, [activeFilePath, hasActionInFlight, saveFile]);

  const continuousOptions = useMemo(
    () => ({
      editorViewMapRef,
      activeFilePath,
      scrollToFile,
      enabled: true,
    }),
    [activeFilePath, editorViewMapRef, scrollToFile]
  );

  const diffNav = useDiffNavigation(
    sortedFiles,
    activeFilePath,
    scrollToFile,
    activeEditorViewRef,
    open,
    acceptHunk,
    rejectHunk,
    () => void requestClose(),
    handleSaveActiveFile,
    continuousOptions,
    getHunkCount
  );

  const reviewHunkOrder = useMemo(() => {
    const offsets: Record<string, number> = {};
    let total = 0;
    for (const file of sortedFiles) {
      offsets[file.filePath] = total;
      total += getHunkCount(file.filePath, file.snippets.length);
    }
    return { offsets, total };
  }, [getHunkCount, sortedFiles]);

  const resolveEditorContext = useCallback(
    (target: Element | null) => {
      const filePath = getEditorFilePathForTarget(target);
      return {
        editor: filePath ? (editorViewMapRef.current.get(filePath) ?? null) : null,
        hasDraft: filePath ? hasDraft(filePath) : false,
      };
    },
    [editorViewMapRef, getEditorFilePathForTarget, hasDraft]
  );
  const getUndoCount = useCallback((): number => getUndoHistory().length, [getUndoHistory]);
  const getRedoCount = useCallback((): number => getRedoHistory().length, [getRedoHistory]);
  const reportManualDraftBlock = useCallback(
    (): void => reportError('Save or discard manual edits before undoing a review action.'),
    [reportError]
  );

  useChangeReviewHistoryKeyboardShortcuts({
    active: open,
    editedCount,
    resolveEditorContext,
    hasActionInFlight,
    getUndoCount,
    getRedoCount,
    undoLatest,
    redoLatest,
    reportManualDraftBlock,
  });

  useEffect(() => {
    if (!open) return;
    return keyboardPort.subscribeRejectCurrentHunk(() => {
      const filePath = activeFilePathRef.current;
      if (!filePath) return;
      const rejected = keyboardPort.rejectCurrentChunk(filePath);
      if (!rejected) return;
      if (
        rejectHunk(filePath, rejected.hunkIndex, rejected.beforeContent, rejected.afterContent) ===
        false
      ) {
        keyboardPort.rollbackContent(filePath, rejected.beforeContent);
        return;
      }
      requestAnimationFrame(() => diffNav.goToNextHunk());
    });
  }, [activeFilePathRef, diffNav, keyboardPort, open, rejectHunk]);

  return { diffNav, reviewHunkOrder };
}
