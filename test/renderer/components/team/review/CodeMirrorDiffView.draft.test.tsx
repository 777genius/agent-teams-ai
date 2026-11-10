import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { rejectChunk as rejectMergeChunk } from '@codemirror/merge';
import { Transaction } from '@codemirror/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeMirrorDiffView } from '../../../../../src/renderer/components/team/review/CodeMirrorDiffView';

import type { EditorView } from '@codemirror/view';
import type { ReviewSerializedEditorState } from '@features/change-review-history/contracts';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

describe('CodeMirrorDiffView draft propagation', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('publishes a draft synchronously and preserves it when editor extensions rebuild', async () => {
    const root = createRoot(container);
    const observed: string[] = [];
    const observedPrevious: Array<string | undefined> = [];
    let view: EditorView | null = null;
    const requireView = (): EditorView => {
      if (!view) throw new Error('CodeMirror view was not mounted');
      return view;
    };
    const renderEditor = (readOnly: boolean, showMergeControls = true): React.ReactElement => (
      <CodeMirrorDiffView
        original={'const value = 1;\n'}
        modified={'const value = 2;\n'}
        fileName="file.txt"
        readOnly={readOnly}
        showMergeControls={showMergeControls}
        collapseUnchanged={false}
        onContentChanged={(content, previousContent) => {
          observed.push(content);
          observedPrevious.push(previousContent);
        }}
        onViewChange={(nextView) => {
          view = nextView;
        }}
      />
    );

    await act(async () => root.render(renderEditor(false)));
    expect(view).not.toBeNull();

    const editableView = requireView();
    const draft = `${editableView.state.doc.toString()}// manual draft\n`;
    editableView.dispatch({
      changes: { from: editableView.state.doc.length, insert: '// manual draft\n' },
    });

    // No timer/microtask advance: guards can see the draft before a collapse/reject click.
    expect(observed).toEqual([draft]);
    expect(observedPrevious).toEqual(['const value = 2;\n']);

    // A parent hides review controls as soon as a draft exists. That prop-only update must not
    // recreate CodeMirror, otherwise the first keypress resets selection/history.
    await act(async () => root.render(renderEditor(false, false)));
    expect(view).toBe(editableView);
    expect(requireView().state.doc.toString()).toBe(draft);

    await act(async () => root.render(renderEditor(true, false)));
    expect(requireView().state.doc.toString()).toBe(draft);

    await act(async () => root.unmount());
    expect(observed.at(-1)).toBe(draft);
  });

  it('restores multiple native undo and redo groups after a full remount', async () => {
    const root = createRoot(container);
    let view: EditorView | null = null;
    let checkpoint: ReviewSerializedEditorState | undefined;
    const observedContent: string[] = [];
    const renderEditor = (modified: string, serializedState?: ReviewSerializedEditorState) => (
      <CodeMirrorDiffView
        original="A"
        modified={modified}
        fileName="file.txt"
        readOnly={false}
        collapseUnchanged={false}
        serializedState={serializedState}
        onContentChanged={(content) => observedContent.push(content)}
        onSerializedStateChanged={(state) => {
          checkpoint = state;
        }}
        onViewChange={(nextView) => {
          view = nextView;
        }}
      />
    );
    const requireView = (): EditorView => {
      if (!view) throw new Error('CodeMirror view was not mounted');
      return view;
    };
    const dispatchGroup = (changes: { from: number; to?: number; insert: string }): void => {
      requireView().dispatch({
        changes,
        annotations: [
          Transaction.userEvent.of('input'),
          isolateHistory.of('full'),
        ],
      });
    };

    await act(async () => root.render(renderEditor('A')));
    dispatchGroup({ from: 1, insert: 'B' });
    const liveView = requireView();
    const firstCheckpoint = checkpoint;
    if (!firstCheckpoint) throw new Error('First editor history checkpoint was not emitted');
    // The real parent stores every checkpoint in React state. Receiving that updated prop
    // must not recreate CodeMirror after each keystroke or destroy the native history branch.
    await act(async () => root.render(renderEditor('A', firstCheckpoint)));
    expect(requireView()).toBe(liveView);
    expect(undoDepth(requireView().state)).toBe(1);

    dispatchGroup({ from: 2, insert: 'C' });
    dispatchGroup({ from: 1, to: 2, insert: 'D' });
    expect(requireView().state.doc.toString()).toBe('ADC');
    expect(undoDepth(requireView().state)).toBe(3);
    expect(checkpoint?.doc).toBe('ADC');

    const persisted = checkpoint;
    if (!persisted) throw new Error('Editor history checkpoint was not emitted');
    observedContent.length = 0;
    await act(async () => root.unmount());

    const restartContainer = document.createElement('div');
    document.body.appendChild(restartContainer);
    const restartRoot = createRoot(restartContainer);
    await act(async () => restartRoot.render(renderEditor('ADC', persisted)));
    expect(observedContent).toEqual([]);
    expect(undoDepth(requireView().state)).toBe(3);

    expect(undo(requireView())).toBe(true);
    expect(requireView().state.doc.toString()).toBe('ABC');
    expect(undo(requireView())).toBe(true);
    expect(requireView().state.doc.toString()).toBe('AB');
    expect(undo(requireView())).toBe(true);
    expect(requireView().state.doc.toString()).toBe('A');
    expect(redoDepth(requireView().state)).toBe(3);

    const afterUndo = checkpoint;
    if (!afterUndo) throw new Error('Undo checkpoint was not emitted');
    await act(async () => restartRoot.unmount());
    const secondRestartRoot = createRoot(restartContainer);
    await act(async () => secondRestartRoot.render(renderEditor('A', afterUndo)));
    expect(redoDepth(requireView().state)).toBe(3);
    expect(redo(requireView())).toBe(true);
    expect(requireView().state.doc.toString()).toBe('AB');

    dispatchGroup({ from: 2, insert: 'X' });
    expect(requireView().state.doc.toString()).toBe('ABX');
    expect(redoDepth(requireView().state)).toBe(0);

    await act(async () => secondRestartRoot.unmount());
    restartContainer.remove();
  });

  it('retains a long manual branch and excludes review decisions from native history', async () => {
    const root = createRoot(container);
    let view: EditorView | null = null;
    let checkpoint: ReviewSerializedEditorState | undefined;
    await act(async () =>
      root.render(
        <CodeMirrorDiffView
          original="before"
          modified="after"
          fileName="file.txt"
          readOnly={false}
          collapseUnchanged={false}
          onSerializedStateChanged={(state) => {
            checkpoint = state;
          }}
          onViewChange={(nextView) => {
            view = nextView;
          }}
        />
      )
    );
    const requireView = (): EditorView => {
      if (!view) throw new Error('CodeMirror view was not mounted');
      return view;
    };

    expect(rejectMergeChunk(requireView())).toBe(true);
    expect(requireView().state.doc.toString()).toBe('before');
    expect(undoDepth(requireView().state)).toBe(0);

    for (let index = 0; index < 150; index++) {
      requireView().dispatch({
        changes: { from: requireView().state.doc.length, insert: String(index % 10) },
        annotations: [Transaction.userEvent.of('input'), isolateHistory.of('full')],
      });
    }
    expect(undoDepth(requireView().state)).toBe(150);
    expect(checkpoint).toBeTruthy();

    const persisted = checkpoint;
    if (!persisted) throw new Error('Long editor history checkpoint was not emitted');
    const finalDoc = requireView().state.doc.toString();
    await act(async () => root.unmount());
    const restarted = createRoot(container);
    await act(async () =>
      restarted.render(
        <CodeMirrorDiffView
          original="before"
          modified={finalDoc}
          fileName="file.txt"
          readOnly={false}
          collapseUnchanged={false}
          serializedState={persisted}
          onViewChange={(nextView) => {
            view = nextView;
          }}
        />
      )
    );
    expect(undoDepth(requireView().state)).toBe(150);
    await act(async () => restarted.unmount());
  });
});
