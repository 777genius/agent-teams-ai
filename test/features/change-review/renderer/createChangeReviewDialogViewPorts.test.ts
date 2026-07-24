import { history } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { createChangeReviewDialogViewPorts } from '@features/change-review/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { EditorView } from '@codemirror/view';
import type { FileChangeSummary } from '@shared/types';
import type { Dispatch, SetStateAction } from 'react';

function createStateSetter<T>(
  getValue: () => T,
  setValue: (value: T) => void
): Dispatch<SetStateAction<T>> {
  return (next) => {
    setValue(typeof next === 'function' ? (next as (previous: T) => T)(getValue()) : next);
  };
}

function createHarness() {
  let filesApplying = new Set<string>();
  let discardCounters: Record<string, number> = {};
  let undoing = false;
  let closing = false;
  const editorState = EditorState.create({ doc: 'draft', extensions: [history()] });
  const editorView = {
    state: editorState,
    dom: { isConnected: true },
    dispatch: vi.fn(),
  } as unknown as EditorView;
  const file: FileChangeSummary = {
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 0,
    isNewFile: false,
  };
  const editorActions = {
    acceptAllChunks: vi.fn(() => true),
    ignoreNextDocChange: vi.fn(),
    rejectAllChunks: vi.fn(() => true),
    rejectChunk: vi.fn(() => true),
  };
  const addReviewFile = vi.fn();
  const fetchFileContent = vi.fn().mockResolvedValue(undefined);
  const navigateToHistoryAction = vi.fn();
  const handleSerializedStateChanged = vi.fn();
  const refs = {
    editorViewMapRef: { current: new Map([[file.filePath, editorView]]) },
    fileApplyInFlightRef: { current: new Set<string>() },
    undoInFlightRef: { current: false },
    closingRef: { current: false },
    pendingApplyCleanupKeyRef: { current: null as string | null },
    expectedDraftHistoryKeyRef: { current: 'hydration-key' as string | null },
    recentReviewWritesRef: {
      current: new Map<string, { at: number; expectedContent: string | null }>(),
    },
  };
  const ports = createChangeReviewDialogViewPorts({
    ...refs,
    editorActions,
    setFilesApplying: createStateSetter(
      () => filesApplying,
      (value) => {
        filesApplying = value;
      }
    ),
    setDiscardCounters: createStateSetter(
      () => discardCounters,
      (value) => {
        discardCounters = value;
      }
    ),
    setUndoing: createStateSetter(
      () => undoing,
      (value) => {
        undoing = value;
      }
    ),
    setClosing: createStateSetter(
      () => closing,
      (value) => {
        closing = value;
      }
    ),
    handleSerializedStateChanged,
    addReviewFile,
    fetchFileContent,
    navigateToHistoryAction,
  });

  return {
    file,
    editorView,
    editorActions,
    refs,
    ports,
    addReviewFile,
    fetchFileContent,
    handleSerializedStateChanged,
    get filesApplying() {
      return filesApplying;
    },
    get discardCounters() {
      return discardCounters;
    },
    get undoing() {
      return undoing;
    },
    get closing() {
      return closing;
    },
  };
}

describe('createChangeReviewDialogViewPorts', () => {
  it('shares editor, mutation-status, and write-evidence bridges across controllers', () => {
    const harness = createHarness();
    vi.spyOn(Date, 'now').mockReturnValue(123);

    harness.ports.fileDecision.editor.acceptAllEditorChunks(harness.file.filePath);
    harness.ports.fileDecision.editor.rejectAllEditorChunks(harness.file.filePath);
    harness.ports.fileDecision.editor.rollbackEditorContent(harness.file.filePath, 'before');
    harness.ports.hunkDecision.status.beginFileMutation(harness.file.filePath);
    harness.ports.fileDraft.status.incrementDiscardCounter(harness.file.filePath);
    harness.ports.hunkDecision.writeEvidence.markExpectedWrite('C:\\Repo\\FILE.ts', 'after');
    harness.ports.hunkDecision.writeEvidence.markCommittedPostimages([
      { filePath: '/repo/deleted.ts', content: null },
    ]);

    expect(harness.editorActions.acceptAllChunks).toHaveBeenCalledWith(harness.editorView);
    expect(harness.editorActions.rejectAllChunks).toHaveBeenCalledWith(harness.editorView);
    expect(harness.editorActions.ignoreNextDocChange).toHaveBeenCalledWith(harness.editorView);
    expect(harness.editorView.dispatch).toHaveBeenCalledOnce();
    expect(harness.refs.fileApplyInFlightRef.current).toContain(harness.file.filePath);
    expect(harness.filesApplying).toContain(harness.file.filePath);
    expect(harness.discardCounters).toEqual({ [harness.file.filePath]: 1 });
    expect(harness.refs.recentReviewWritesRef.current).toEqual(
      new Map([
        ['c:/repo/file.ts', { at: 123, expectedContent: 'after' }],
        ['/repo/deleted.ts', { at: 123, expectedContent: null }],
      ])
    );

    harness.ports.hunkDecision.writeEvidence.clearExpectedWrite('C:\\Repo\\FILE.ts');
    expect(harness.refs.recentReviewWritesRef.current.has('c:/repo/file.ts')).toBe(false);

    harness.ports.hunkDecision.status.finishFileMutation(harness.file.filePath);
    expect(harness.refs.fileApplyInFlightRef.current).not.toContain(harness.file.filePath);
    expect(harness.filesApplying).not.toContain(harness.file.filePath);
  });

  it('maps history and lifecycle state without exposing dialog refs', () => {
    const harness = createHarness();

    harness.ports.historyMutation.addMissingFile(harness.file, 2, 'restored');
    harness.ports.historyMutation.fetchFileContent('team', 'alice', harness.file.filePath);
    harness.ports.historyMutation.setMutationInFlight(true);
    harness.ports.lifecycle.editor.captureDraftSnapshots(() => true);
    harness.ports.lifecycle.session.setPendingApplyCleanupKey('cleanup');
    harness.ports.lifecycle.status.beginClosing();

    expect(harness.addReviewFile).toHaveBeenCalledWith(
      harness.file,
      expect.objectContaining({
        index: 2,
        content: expect.objectContaining({
          modifiedFullContent: 'restored',
          contentSource: 'disk-current',
        }),
      })
    );
    expect(harness.fetchFileContent).toHaveBeenCalledWith('team', 'alice', harness.file.filePath);
    expect(harness.refs.undoInFlightRef.current).toBe(true);
    expect(harness.undoing).toBe(true);
    expect(harness.handleSerializedStateChanged).toHaveBeenCalledWith(
      harness.file.filePath,
      expect.objectContaining({ doc: 'draft' })
    );
    expect(harness.ports.lifecycle.session.getPendingApplyCleanupKey()).toBe('cleanup');
    expect(harness.ports.lifecycle.session.isExpectedHydrationKey('hydration-key')).toBe(true);
    expect(harness.refs.closingRef.current).toBe(true);
    expect(harness.closing).toBe(true);
    expect(harness.ports.lifecycle.status.getActionLockState(false)).toEqual({
      applying: false,
      fileApplyCount: 0,
      undoing: true,
      closing: true,
    });
  });
});
