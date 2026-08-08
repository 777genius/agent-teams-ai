import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { history } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { useChangeReviewHistoryKeyboardShortcuts } from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChangeReviewKeyboardEditorContext } from '@features/change-review/renderer';

interface ProbeProps {
  active: boolean;
  editedCount: number;
  context: ChangeReviewKeyboardEditorContext;
  inFlight: boolean;
  undoCount: number;
  redoCount: number;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  reportBlock: () => void;
}

function Probe(props: ProbeProps): React.JSX.Element {
  useChangeReviewHistoryKeyboardShortcuts({
    active: props.active,
    editedCount: props.editedCount,
    resolveEditorContext: () => props.context,
    hasActionInFlight: () => props.inFlight,
    getUndoCount: () => props.undoCount,
    getRedoCount: () => props.redoCount,
    undoLatest: props.undo,
    redoLatest: props.redo,
    reportManualDraftBlock: props.reportBlock,
  });
  return <div />;
}

function shortcut(input: { redo?: boolean; keyY?: boolean } = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    code: input.keyY ? 'KeyY' : 'KeyZ',
    shiftKey: input.redo ?? false,
  });
}

describe('useChangeReviewHistoryKeyboardShortcuts', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('preserves input and native CodeMirror history priority', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    const input = document.body.appendChild(document.createElement('input'));
    const undo = vi.fn(async () => {});
    const redo = vi.fn(async () => {});
    const reportBlock = vi.fn();
    const baseProps = {
      active: true,
      editedCount: 0,
      context: { editor: null, hasDraft: false },
      inFlight: false,
      undoCount: 1,
      redoCount: 1,
      undo,
      redo,
      reportBlock,
    };
    await act(async () => root.render(<Probe {...baseProps} />));
    input.focus();
    const inputEvent = shortcut();
    input.dispatchEvent(inputEvent);
    expect(inputEvent.defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();

    let editorState = EditorState.create({ doc: 'a', extensions: [history()] });
    editorState = editorState.update({ changes: { from: 1, insert: 'b' } }).state;
    await act(async () => {
      root.render(
        <Probe
          {...baseProps}
          context={{
            editor: { state: editorState } as ChangeReviewKeyboardEditorContext['editor'],
            hasDraft: true,
          }}
        />
      );
    });
    host.focus();
    const nativeEvent = shortcut();
    document.dispatchEvent(nativeEvent);
    expect(nativeEvent.defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('blocks in-flight and manual-draft-conflicted actions with preventDefault parity', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const undo = vi.fn(async () => {});
    const redo = vi.fn(async () => {});
    const reportBlock = vi.fn();
    const render = async (inFlight: boolean, editedCount: number) => {
      await act(async () => {
        root.render(
          <Probe
            active
            editedCount={editedCount}
            context={{ editor: null, hasDraft: false }}
            inFlight={inFlight}
            undoCount={1}
            redoCount={1}
            undo={undo}
            redo={redo}
            reportBlock={reportBlock}
          />
        );
      });
    };

    await render(true, 0);
    const blocked = shortcut();
    document.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    expect(undo).not.toHaveBeenCalled();

    await render(false, 1);
    const manualDraft = shortcut();
    document.dispatchEvent(manualDraft);
    expect(manualDraft.defaultPrevented).toBe(true);
    expect(reportBlock).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();

    const redoBlocked = shortcut({ redo: true });
    document.dispatchEvent(redoBlocked);
    expect(redoBlocked.defaultPrevented).toBe(true);
    expect(redo).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('routes undo/redo, prevents no-history native undo, and removes capture listener', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const undo = vi.fn(async () => {});
    const redo = vi.fn(async () => {});
    const reportBlock = vi.fn();
    const render = async (undoCount: number, redoCount: number) => {
      await act(async () => {
        root.render(
          <Probe
            active
            editedCount={0}
            context={{ editor: null, hasDraft: false }}
            inFlight={false}
            undoCount={undoCount}
            redoCount={redoCount}
            undo={undo}
            redo={redo}
            reportBlock={reportBlock}
          />
        );
      });
    };

    await render(1, 1);
    document.dispatchEvent(shortcut());
    document.dispatchEvent(shortcut({ keyY: true }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);

    await render(0, 0);
    const noHistory = shortcut();
    document.dispatchEvent(noHistory);
    expect(noHistory.defaultPrevented).toBe(true);
    await act(async () => root.unmount());

    const afterCleanup = shortcut();
    document.dispatchEvent(afterCleanup);
    expect(afterCleanup.defaultPrevented).toBe(false);
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
