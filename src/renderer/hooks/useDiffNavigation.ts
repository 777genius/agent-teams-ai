import { useCallback, useEffect, useRef, useState } from 'react';

import { acceptChunk, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';

import type { EditorView } from '@codemirror/view';
import type { FileChangeSummary } from '@shared/types/review';

interface DiffNavigationState {
  currentHunkIndex: number;
  totalHunks: number;
  goToNextHunk: () => void;
  goToPrevHunk: () => void;
  goToNextFile: () => void;
  goToPrevFile: () => void;
  goToHunk: (index: number) => void;
  acceptCurrentHunk: () => void;
  rejectCurrentHunk: () => void;
  showShortcutsHelp: boolean;
  setShowShortcutsHelp: (show: boolean) => void;
}

export function useDiffNavigation(
  files: FileChangeSummary[],
  selectedFilePath: string | null,
  onSelectFile: (path: string) => void,
  editorViewRef: React.RefObject<EditorView | null>,
  isDialogOpen: boolean,
  onHunkAccepted?: (filePath: string, hunkIndex: number) => void,
  onHunkRejected?: (filePath: string, hunkIndex: number) => void,
  onClose?: () => void,
  onSaveFile?: () => void
): DiffNavigationState {
  // Track hunk index keyed by file path to auto-reset on file change
  const [hunkState, setHunkState] = useState<{ filePath: string | null; index: number }>({
    filePath: selectedFilePath,
    index: 0,
  });
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);

  const selectedFile = files.find((f) => f.filePath === selectedFilePath);
  const totalHunks = selectedFile?.snippets.length ?? 0;

  // Derive currentHunkIndex: reset to 0 when selectedFilePath changes
  const currentHunkIndex = hunkState.filePath === selectedFilePath ? hunkState.index : 0;

  const setCurrentHunkIndex = useCallback(
    (updater: number | ((prev: number) => number)) => {
      setHunkState((prev) => {
        const newIndex =
          typeof updater === 'function'
            ? updater(prev.filePath === selectedFilePath ? prev.index : 0)
            : updater;
        return { filePath: selectedFilePath, index: newIndex };
      });
    },
    [selectedFilePath]
  );

  const goToNextHunk = useCallback(() => {
    const view = editorViewRef.current;
    if (view) {
      goToNextChunk(view);
    }
    setCurrentHunkIndex((prev) => Math.min(prev + 1, totalHunks - 1));
  }, [editorViewRef, totalHunks, setCurrentHunkIndex]);

  const goToPrevHunk = useCallback(() => {
    const view = editorViewRef.current;
    if (view) {
      goToPreviousChunk(view);
    }
    setCurrentHunkIndex((prev) => Math.max(prev - 1, 0));
  }, [editorViewRef, setCurrentHunkIndex]);

  const goToNextFile = useCallback(() => {
    if (files.length === 0) return;
    const currentIdx = files.findIndex((f) => f.filePath === selectedFilePath);
    const nextIdx = currentIdx < files.length - 1 ? currentIdx + 1 : 0;
    onSelectFile(files[nextIdx].filePath);
  }, [files, selectedFilePath, onSelectFile]);

  const goToPrevFile = useCallback(() => {
    if (files.length === 0) return;
    const currentIdx = files.findIndex((f) => f.filePath === selectedFilePath);
    const prevIdx = currentIdx > 0 ? currentIdx - 1 : files.length - 1;
    onSelectFile(files[prevIdx].filePath);
  }, [files, selectedFilePath, onSelectFile]);

  const goToHunk = useCallback(
    (index: number) => {
      setCurrentHunkIndex(Math.max(0, Math.min(index, totalHunks - 1)));
    },
    [totalHunks, setCurrentHunkIndex]
  );

  const acceptCurrentHunk = useCallback(() => {
    if (selectedFilePath && onHunkAccepted) {
      onHunkAccepted(selectedFilePath, currentHunkIndex);
    }
  }, [selectedFilePath, currentHunkIndex, onHunkAccepted]);

  const rejectCurrentHunk = useCallback(() => {
    if (selectedFilePath && onHunkRejected) {
      onHunkRejected(selectedFilePath, currentHunkIndex);
    }
  }, [selectedFilePath, currentHunkIndex, onHunkRejected]);

  // Store refs for stable closure
  const onCloseRef = useRef(onClose);
  const onSaveFileRef = useRef(onSaveFile);

  useEffect(() => {
    onCloseRef.current = onClose;
    onSaveFileRef.current = onSaveFile;
  }, [onClose, onSaveFile]);

  // Keyboard handler — new shortcuts for editable diff
  useEffect(() => {
    if (!isDialogOpen) return;

    const handler = (event: KeyboardEvent) => {
      // Skip if CM keymap already handled this event
      if (event.defaultPrevented) return;
      // Skip inputs/textareas
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      const isMeta = event.metaKey || event.ctrlKey;

      // Alt+J -> next change
      if (event.altKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        const view = editorViewRef.current;
        if (view) goToNextChunk(view);
        return;
      }

      // Cmd+Enter -> save file
      if (isMeta && event.key === 'Enter') {
        event.preventDefault();
        onSaveFileRef.current?.();
        return;
      }

      // Cmd+Y -> accept + scroll (fallback when editor not focused)
      if (isMeta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        const view = editorViewRef.current;
        if (view) {
          acceptChunk(view);
          requestAnimationFrame(() => goToNextChunk(view));
        }
        return;
      }

      // Escape handling
      if (event.key === 'Escape') {
        if (showShortcutsHelp) {
          event.preventDefault();
          setShowShortcutsHelp(false);
        }
        // Note: main Escape handling for closing dialog is in ChangeReviewDialog itself
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isDialogOpen, showShortcutsHelp, editorViewRef]);

  return {
    currentHunkIndex,
    totalHunks,
    goToNextHunk,
    goToPrevHunk,
    goToNextFile,
    goToPrevFile,
    goToHunk,
    acceptCurrentHunk,
    rejectCurrentHunk,
    showShortcutsHelp,
    setShowShortcutsHelp,
  };
}
