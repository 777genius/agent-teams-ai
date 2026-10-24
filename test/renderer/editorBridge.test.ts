import { EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';

import { editorBridge } from '../../src/renderer/utils/editorBridge';

import type { EditorView } from '@codemirror/view';

// Independent contract: save uses the current transaction, readonly text cannot be
// serialized for save, and cached dirty states outlive individual editor views.
afterEach(() => { editorBridge.unregister(); editorBridge.states.clear(); editorBridge.destroy(); });
describe('editor bridge session state', () => {
  it('serializes the live document instead of the stale mount snapshot', () => {
    const original = EditorState.create({ doc: 'original\r\nTAIL', extensions: EditorState.lineSeparator.of('\r\n') });
    const edited = original.update({ changes: { from: 0, insert: 'EDIT-' } }).state;
    const cache = new Map([['file', original]]);
    editorBridge.register(cache, new Map(), { state: edited } as EditorView, 'file');
    expect(editorBridge.getContent('file')).toBe('EDIT-original\r\nTAIL');
    expect(editorBridge.getAllModifiedContent({ file: true }).get('file')).toBe('EDIT-original\r\nTAIL');
  });

  it('keeps unsaved state, undo history and scroll position between view lifetimes', () => {
    const state = EditorState.create({ doc: 'unsaved-tail' });
    editorBridge.states.set('file', state);
    editorBridge.scrolls.set('file', 77);
    editorBridge.prepareState('file', 1, false, false);
    editorBridge.register(editorBridge.states, editorBridge.scrolls, { state } as EditorView, 'file');
    editorBridge.unregister();
    editorBridge.prepareState('file', 2, false, true);
    expect(editorBridge.states.get('file')).toBe(state);
    expect(editorBridge.scrolls.get('file')).toBe(77);
    expect(editorBridge.getContent('file')).toBe('unsaved-tail');
    editorBridge.prepareState('file', 3, false, false);
    expect(editorBridge.states.has('file')).toBe(false);
  });

  it('refuses all save serialization for a readonly preview', () => {
    const state = EditorState.create({ doc: 'partial', extensions: EditorState.readOnly.of(true) });
    editorBridge.register(new Map([['preview', state]]), new Map(), { state } as EditorView, 'preview');
    expect(editorBridge.getContent('preview')).toBeNull();
    expect(editorBridge.getAllModifiedContent({ preview: true }).size).toBe(0);
  });

  it('renames an active unsaved document without copying the stale mount snapshot', () => {
    const original = EditorState.create({ doc: 'original' });
    const edited = original.update({ changes: { from: 0, insert: 'EDIT-' } }).state;
    editorBridge.states.set('old', original);
    editorBridge.register(editorBridge.states, editorBridge.scrolls,
      { state: edited, scrollDOM: { scrollTop: 123 } } as EditorView, 'old');
    const oldRevision = editorBridge.revision('old');
    editorBridge.remapState('old', 'new');
    editorBridge.remapState('old', 'new');
    expect(editorBridge.getContent('new')).toBe('EDIT-original');
    expect(editorBridge.states.get('new')).toBe(edited);
    expect(editorBridge.states.has('old')).toBe(false);
    expect(editorBridge.scrolls.get('new')).toBe(123);
    expect(editorBridge.revision('old')).not.toBe(oldRevision);
  });

  it('retains a clean document that is protected by an in-flight save under memory pressure', () => {
    editorBridge.states.set('saving', EditorState.create({ doc: 'a'.repeat(17 * 1024 * 1024) }));
    editorBridge.states.set('active', EditorState.create({ doc: 'b'.repeat(17 * 1024 * 1024) }));
    editorBridge.touchState('active', { saving: true });
    expect(editorBridge.states.has('saving')).toBe(true);
    expect(editorBridge.states.has('active')).toBe(true);
  });

  it('evicts clean documents under memory pressure but retains dirty text', () => {
    editorBridge.states.set('dirty', EditorState.create({ doc: 'a'.repeat(17 * 1024 * 1024) }));
    editorBridge.states.set('clean', EditorState.create({ doc: 'b'.repeat(17 * 1024 * 1024) }));
    editorBridge.states.set('active', EditorState.create({ doc: 'c'.repeat(17 * 1024 * 1024) }));
    editorBridge.touchState('active', { dirty: true });
    expect(editorBridge.states.has('dirty')).toBe(true);
    expect(editorBridge.states.has('active')).toBe(true);
    expect(editorBridge.states.has('clean')).toBe(false);
  });
});
