import { EditorState } from '@codemirror/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const write = vi.hoisted(() => vi.fn());
vi.mock('@renderer/api', () => ({ api: { editor: { writeFile: write } } }));

import { editorBridge } from '../../src/renderer/utils/editorBridge';
import { createTestStore } from './store/storeTestUtils';

import type { EditorView } from '@codemirror/view';

beforeEach(() => { write.mockReset(); });
afterEach(() => { editorBridge.unregister(); editorBridge.destroy(); });

function setup() {
  const store = createTestStore();
  const view = { state: EditorState.create({ doc: 'saved-snapshot' }), destroy: vi.fn() };
  editorBridge.states.set('file', view.state);
  editorBridge.register(editorBridge.states, editorBridge.scrolls, view as unknown as EditorView, 'file');
  store.setState({ editorModifiedFiles: { file: true }, editorFileMtimes: { file: 1 } });
  return { store, view };
}

// Regressions: async write acknowledgements must not mark newer edits as saved,
// and old-session completions must not alter a reopened editor.
describe('editor asynchronous saves', () => {
  it.each(['saveFile', 'forceOverwrite', 'saveAllFiles'] as const)('%s retains edits made during IPC save', async (action) => {
    const { store, view } = setup();
    let finish!: (result: { mtimeMs: number; size: number }) => void;
    write.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = action === 'saveAllFiles' ? store.getState()[action]() : store.getState()[action]('file');
    expect(write.mock.calls[0]?.[1]).toBe('saved-snapshot');
    view.state = view.state.update({ changes: { from: 0, insert: 'NEW-' } }).state;
    finish({ mtimeMs: 2, size: 14 });
    await pending;
    expect(store.getState().editorModifiedFiles.file).toBe(true);
    expect(store.getState().editorFileMtimes.file).toBe(2);
    expect(store.getState().editorSaving.file).toBeUndefined();
    expect(editorBridge.getContent('file')).toBe('NEW-saved-snapshot');
  });

  it('ignores a completed save from a previous editor session', async () => {
    const { store } = setup();
    let finish!: (result: { mtimeMs: number; size: number }) => void;
    write.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = store.getState().saveFile('file');
    editorBridge.destroy();
    const current = EditorState.create({ doc: 'new-session' });
    editorBridge.states.set('file', current);
    editorBridge.register(editorBridge.states, editorBridge.scrolls, { state: current } as EditorView, 'file');
    store.setState({ editorModifiedFiles: { file: true }, editorFileMtimes: { file: 999 }, editorSaving: {} });
    finish({ mtimeMs: 2, size: 14 });
    await pending;
    expect(store.getState().editorFileMtimes.file).toBe(999);
    expect(store.getState().editorModifiedFiles.file).toBe(true);
  });

  it('clears only an obsolete save request that still owns its saving flag', async () => {
    const { store } = setup();
    let finish!: (result: { mtimeMs: number; size: number }) => void;
    write.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = store.getState().saveFile('file');
    editorBridge.deleteState('file');
    finish({ mtimeMs: 2, size: 14 });
    await pending;
    expect(store.getState().editorSaving.file).toBeUndefined();
    expect(store.getState().editorModifiedFiles.file).toBe(true);
    expect(store.getState().editorFileMtimes.file).toBe(1);
  });

  it('does not clear a newer save flag when an invalidated request finishes', async () => {
    const { store, view } = setup();
    const finish: ((result: { mtimeMs: number; size: number }) => void)[] = [];
    write.mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));
    const old = store.getState().saveFile('file');
    editorBridge.deleteState('file');
    store.setState({ editorSaving: {} });
    editorBridge.states.set('file', view.state);
    const newer = store.getState().saveFile('file');
    finish[0]({ mtimeMs: 2, size: 14 });
    await old;
    expect(store.getState().editorSaving.file).toBe(true);
    finish[1]({ mtimeMs: 3, size: 14 });
    await newer;
    expect(store.getState().editorSaving.file).toBeUndefined();
    expect(store.getState().editorFileMtimes.file).toBe(3);
  });

  it('keeps dirty content and reports failure rather than acknowledging an oversized save', async () => {
    const { store } = setup();
    write.mockRejectedValue(new Error('Content too large'));
    await store.getState().saveFile('file');
    expect(store.getState().editorModifiedFiles.file).toBe(true);
    expect(store.getState().editorSaveError.file).toBe('Content too large');
    expect(vi.mocked(console.error).mock.calls).toEqual([['[EditorSaveActions]', 'Failed to save file:', 'file', 'Content too large']]);
    vi.mocked(console.error).mockClear();
    expect(editorBridge.getContent('file')).toBe('saved-snapshot');
  });
});
