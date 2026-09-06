import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MembersJsonEditor } from './MembersJsonEditor';

describe('MembersJsonEditor', () => {
  const container = document.createElement('div');
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('does not echo form updates as JSON edits, while preserving manual editing', () => {
    document.body.append(container);
    root = createRoot(container);
    const onChange = vi.fn();
    const render = (value: string) =>
      act(() =>
        root.render(
          <MembersJsonEditor
            value={value}
            onChange={onChange}
            error={null}
            onClose={() => undefined}
          />
        )
      );
    render('[{"name":"worker","model":"old"}]');
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    expect(view).toBeTruthy();

    render('[{"name":"worker","model":"new"}]');
    expect(view.state.doc.toString()).toContain('"model":"new"');
    expect(onChange).not.toHaveBeenCalled();

    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '[]' } }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('[]');
  });
});
