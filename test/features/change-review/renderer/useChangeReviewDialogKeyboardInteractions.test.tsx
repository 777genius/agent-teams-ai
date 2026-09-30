import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChangeReviewDialogKeyboardInteractions } from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChangeReviewDialogKeyboardInteractionPort } from '@features/change-review/renderer';
import type { FileChangeSummary } from '@shared/types';

const file: FileChangeSummary = {
  filePath: '/repo/a.ts',
  relativePath: 'a.ts',
  snippets: [],
  linesAdded: 2,
  linesRemoved: 0,
  isNewFile: false,
};

interface Harness {
  listener: (() => void) | null;
  unsubscribe: ReturnType<typeof vi.fn>;
  rejectHunk: ReturnType<typeof vi.fn>;
  keyboardPort: ChangeReviewDialogKeyboardInteractionPort;
}

let latestResult: ReturnType<typeof useChangeReviewDialogKeyboardInteractions> | null = null;

function Probe({
  harness,
  open = true,
}: Readonly<{ harness: Harness; open?: boolean }>): React.JSX.Element {
  latestResult = useChangeReviewDialogKeyboardInteractions({
    open,
    activeFilePath: file.filePath,
    activeFilePathRef: { current: file.filePath },
    activeEditorViewRef: { current: null },
    editorViewMapRef: { current: new Map() },
    sortedFiles: [file],
    fileChunkCounts: { [file.filePath]: 2 },
    editedCount: 0,
    scrollToFile: vi.fn(),
    saveFile: vi.fn().mockResolvedValue(undefined),
    requestClose: vi.fn().mockResolvedValue(undefined),
    acceptHunk: vi.fn(),
    rejectHunk: harness.rejectHunk,
    hasDraft: () => false,
    hasActionInFlight: () => false,
    getEditorFilePathForTarget: () => null,
    getHunkCountForFile: (_filePath, fallback, counts) => counts[file.filePath] ?? fallback,
    getUndoHistory: () => [],
    getRedoHistory: () => [],
    undoLatest: vi.fn().mockResolvedValue(undefined),
    redoLatest: vi.fn().mockResolvedValue(undefined),
    reportError: vi.fn(),
    keyboardPort: harness.keyboardPort,
  });
  return <div />;
}

describe('useChangeReviewDialogKeyboardInteractions', () => {
  afterEach(() => {
    latestResult = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('preserves ordered hunk offsets and rolls back a rejected shortcut decision', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const harness = {
      listener: null,
      unsubscribe: vi.fn(),
      rejectHunk: vi.fn(() => false),
    } as Harness;
    harness.keyboardPort = {
      subscribeRejectCurrentHunk: (listener) => {
        harness.listener = listener;
        return harness.unsubscribe;
      },
      rejectCurrentChunk: vi.fn(() => ({
        hunkIndex: 1,
        beforeContent: 'before',
        afterContent: 'after',
      })),
      rollbackContent: vi.fn(),
    };
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    act(() => root.render(<Probe harness={harness} />));
    expect(latestResult?.reviewHunkOrder).toEqual({
      offsets: { [file.filePath]: 0 },
      total: 2,
    });

    act(() => harness.listener?.());
    expect(harness.rejectHunk).toHaveBeenCalledWith(file.filePath, 1, 'before', 'after');
    expect(harness.keyboardPort.rollbackContent).toHaveBeenCalledWith(file.filePath, 'before');

    act(() => root.render(<Probe harness={harness} open={false} />));
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });
});
