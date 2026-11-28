import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { undoDepth } from '@codemirror/commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getChunks } from '../../../../../src/renderer/components/team/review/CodeMirrorDiffUtils';
import { CodeMirrorDiffView } from '../../../../../src/renderer/components/team/review/CodeMirrorDiffView';

import type { EditorView } from '@codemirror/view';
import type { Root } from 'react-dom/client';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

describe('CodeMirrorDiffView hovered review actions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: Map<number, FrameRequestCallback>;
  let view: EditorView | null;
  let hit: Element | null;
  const original = 'const first = 1;\n' + 'const middle = true;\n'.repeat(12) + 'const last = 1;\n';
  const modified = original.replace('first = 1', 'first = 2').replace('last = 1', 'last = 2');
  const accepted = vi.fn();
  const rejected = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    frames = new Map();
    let nextFrameId = 0;
    view = null;
    hit = null;
    accepted.mockReset();
    rejected.mockReset();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // Happy DOM has no layout/hit testing. The component, merge state, transactions,
    // native review buttons and their callbacks are real.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const height = this.classList.contains('cm-line') ? 20 : 600;
      return { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: height, width: 800, height,
        toJSON: () => ({}) };
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(document, 'elementFromPoint').mockImplementation(() => hit);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const currentView = (): EditorView => {
    if (!view) throw new Error('The original editor is not mounted');
    return view;
  };
  const toolbar = (): HTMLDivElement => {
    const element = container.querySelector<HTMLDivElement>('[data-review-floating-toolbar="true"]');
    if (!element) throw new Error('Original review toolbar is absent');
    return element;
  };
  const render = (showMergeControls = true, readOnly = false): void => {
    act(() => root.render(
      <CodeMirrorDiffView
        original={original}
        modified={modified}
        fileName="value.txt"
        collapseUnchanged={false}
        showMergeControls={showMergeControls}
        readOnly={readOnly}
        onHunkAccepted={accepted}
        onHunkRejected={rejected}
        onViewChange={(next) => { view = next; }}
      />
    ));
    vi.spyOn(currentView(), 'posAtCoords').mockImplementation(() => {
      const text = hit?.textContent;
      for (let index = 1; index <= currentView().state.doc.lines; index++) {
        const line = currentView().state.doc.line(index);
        if (line.text === text) return line.from;
      }
      return null;
    });
  };
  const runQueuedFrame = (pending = [...frames.keys()]): void => {
    act(() => {
      for (const id of pending) {
        const callback = frames.get(id);
        frames.delete(id);
        callback?.(0);
      }
    });
  };
  const hover = (text: string): void => {
    hit = [...container.querySelectorAll('.cm-line')].find((line) => line.textContent === text) ?? null;
    expect(hit, JSON.stringify([...container.querySelectorAll('.cm-line')].map(line => line.textContent)))
      .not.toBeNull();
    act(() => hit!.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: 120, clientY: 200,
    })));
  };
  const press = (decision: 'accept' | 'reject'): void => {
    const button = toolbar().querySelector<HTMLButtonElement>(
      `button[title="review.diffControls.${decision}Change"]`
    );
    expect(button).not.toBeNull();
    act(() => button!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
  };

  it('keeps the next hovered hunk actionable when an earlier Keep queues editor frames', () => {
    render();
    expect(getChunks(currentView().state)?.chunks).toHaveLength(2);
    runQueuedFrame();
    hover('const first = 2;');
    expect(toolbar().style.display).toBe('flex');
    press('accept');
    expect(accepted.mock.calls).toEqual([[0]]);
    expect(currentView().state.doc.toString()).toBe(modified);
    expect(getChunks(currentView().state)?.chunks).toHaveLength(1);

    hover('const last = 2;');
    expect(toolbar().style.display).toBe('flex');
    expect(frames.size).toBeGreaterThan(0);
    runQueuedFrame();
    expect(toolbar().style.display).toBe('flex');
    press('reject');
    const mixed = modified.replace('last = 2', 'last = 1');
    expect(currentView().state.doc.toString()).toBe(mixed);
    expect(rejected.mock.calls).toEqual([[0, modified, mixed]]);
    expect(getChunks(currentView().state)?.chunks).toHaveLength(0);
    expect(undoDepth(currentView().state)).toBe(0);
    runQueuedFrame();
    expect(toolbar().style.display).toBe('none');
  });

  it('does not resurrect controls when the pointer leaves before queued editor frames run', () => {
    render();
    hover('const first = 2;');
    expect(toolbar().style.display).toBe('flex');
    currentView().dispatch({ selection: { anchor: 1 } });
    act(() => hit!.dispatchEvent(new MouseEvent('mouseout', {
      bubbles: true, relatedTarget: document.body,
    })));
    hit = document.body;
    runQueuedFrame();
    expect(toolbar().style.display).toBe('none');
    expect(accepted).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
  });

  it('does not let an old view frame hide or mutate the newly mounted hovered view', () => {
    render();
    hover('const first = 2;');
    const previous = currentView();
    previous.dispatch({ selection: { anchor: 1 } });
    const oldFrames = [...frames.keys()];
    expect(oldFrames.length).toBeGreaterThan(0);
    render(true, true);
    expect(currentView()).not.toBe(previous);
    hover('const last = 2;');
    expect(toolbar().style.display).toBe('flex');
    const state = currentView().state;
    expect(oldFrames.some(id => frames.has(id))).toBe(true);
    vi.mocked(previous.posAtCoords).mockClear();
    runQueuedFrame(oldFrames);
    expect(previous.posAtCoords).not.toHaveBeenCalled();
    expect(toolbar().style.display).toBe('flex');
    expect(currentView().state).toBe(state);
    expect(accepted).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
  });

  it('hides rather than adopting a foreign toolbar under the retained pointer coordinates', () => {
    render();
    hover('const first = 2;');
    expect(toolbar().style.display).toBe('flex');
    const foreign = document.createElement('div');
    foreign.setAttribute('data-review-floating-toolbar', 'true');
    document.body.appendChild(foreign);
    try {
      hit = foreign;
      currentView().dispatch({ selection: { anchor: 1 } });
      runQueuedFrame();
      expect(toolbar().style.display).toBe('none');
      expect(currentView().state.doc.toString()).toBe(modified);
      expect(accepted).not.toHaveBeenCalled();
      expect(rejected).not.toHaveBeenCalled();
    } finally {
      foreign.remove();
    }
  });

  it('hides controls on unchanged text and preserves a parent disabling merge actions', () => {
    render();
    hover('const first = 2;');
    hover('const middle = true;');
    currentView().dispatch({ selection: { anchor: 1 } });
    runQueuedFrame();
    expect(toolbar().style.display).toBe('none');
    hover('const last = 2;');
    expect(toolbar().style.display).toBe('flex');
    render(false);
    runQueuedFrame();
    expect(container.querySelector('[data-review-floating-toolbar="true"]')).toBeNull();
    expect(currentView().state.doc.toString()).toBe(modified);
    expect(accepted).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
  });
});
