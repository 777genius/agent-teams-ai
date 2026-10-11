import { describe, expect, it, vi } from 'vitest';

import { FolderController } from '../../../src/features/task-folders/core/application/folderController';
import {
  append,
  applyCommand,
  emptySnapshot,
  validateSnapshot,
} from '../../../src/features/task-folders/core/domain/folders';
import {
  BrowserFolderRepository,
  FOLDERS_STORAGE_KEY,
} from '../../../src/features/task-folders/renderer/adapters/browserRepository';

import type { Snapshot } from '../../../src/features/task-folders/core/domain/folders';
const identity = { teamName: 'team:a', taskId: 'b' };
function fixture(): Snapshot {
  let s = applyCommand(emptySnapshot(), { type: 'create', id: 'a', parent: null, name: 'A' });
  s = applyCommand(s, { type: 'create', id: 'b', parent: 'a', name: 'B' });
  return applyCommand(s, { type: 'moveTask', identity, parent: 'b', anchor: append });
}
describe('folder invariants and durable commands', () => {
  it('rejects cycles, duplicate placements and disconnected schema without touching the input', () => {
    const s = fixture();
    const before = JSON.stringify(s);
    expect(() =>
      applyCommand(s, { type: 'moveFolder', id: 'a', parent: 'b', anchor: append })
    ).toThrow('cycle');
    const invalid = structuredClone(s);
    invalid.folders[0].children.push({ kind: 'task', identity });
    expect(() => validateSnapshot(invalid)).toThrow();
    const detached = structuredClone(s);
    detached.rootFolderIds = [];
    expect(() => validateSnapshot(detached)).toThrow();
    expect(JSON.stringify(s)).toBe(before);
  });
  it('promotes nested contents at the deleted position and unfiles tasks only when deleting root', () => {
    const nested = applyCommand(fixture(), { type: 'delete', id: 'b' });
    expect(nested.folders[0].children).toEqual([{ kind: 'task', identity }]);
    const root = applyCommand(fixture(), { type: 'delete', id: 'a' });
    expect(root.rootFolderIds).toEqual(['b']);
    expect(root.folders[0].children).toEqual([{ kind: 'task', identity }]);
    expect(applyCommand(root, { type: 'delete', id: 'b' }).folders).toEqual([]);
  });
  it('resolves stable anchors after removal and retains unavailable siblings in their canonical order', () => {
    const unknown = { teamName: 'unavailable', taskId: 'u' };
    const s = fixture();
    s.folders[0].children = [
      { kind: 'task', identity: unknown },
      { kind: 'folder', id: 'b' },
    ];
    const moved = applyCommand(s, {
      type: 'moveTask',
      identity,
      parent: 'a',
      anchor: { before: { kind: 'folder', id: 'b' } },
    });
    expect(moved.folders[0].children).toEqual([
      { kind: 'task', identity: unknown },
      { kind: 'task', identity },
      { kind: 'folder', id: 'b' },
    ]);
    expect(() =>
      applyCommand(moved, {
        type: 'moveTask',
        identity,
        parent: 'a',
        anchor: { before: { kind: 'folder', id: 'gone' } },
      })
    ).toThrow('missing-anchor');
  });
  it('serializes rapid commands, publishes only successful saves, and retries against latest committed state', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saves: Snapshot[] = [];
    const save = vi.fn(async (s: Snapshot) => {
      if (saves.length === 0) await gate;
      saves.push(s);
    });
    const controller = new FolderController({ load: async () => ({ kind: 'empty' }), save });
    await controller.load();
    const a = controller.execute({ type: 'create', id: 'a', name: 'A', parent: null });
    const b = controller.execute({ type: 'create', id: 'b', name: 'B', parent: 'a' });
    await Promise.resolve();
    expect(controller.getSnapshot().snapshot.folders).toEqual([]);
    release();
    await Promise.all([a, b]);
    expect(saves.map((s) => s.revision)).toEqual([1, 2]);
    save.mockRejectedValueOnce(new Error('quota'));
    await expect(controller.execute({ type: 'rename', id: 'b', name: 'Changed' })).rejects.toThrow(
      'quota'
    );
    expect(controller.getSnapshot().snapshot.folders[1].name).toBe('B');
    await controller.retry();
    expect(controller.getSnapshot().snapshot.folders[1].name).toBe('Changed');
    expect(controller.getSnapshot().snapshot.revision).toBe(3);
  });
  it('blocks writes until load succeeds and rechecks task availability when queued moves execute', async () => {
    let finish!: (result: { kind: 'valid'; snapshot: Snapshot }) => void;
    const save = vi.fn(async () => undefined);
    const controller = new FolderController({
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      save,
    });
    controller.setCatalog([identity]);
    const pending = controller.execute({
      type: 'moveTask',
      identity,
      parent: null,
      anchor: append,
    });
    await Promise.resolve();
    controller.setCatalog([]);
    finish({ kind: 'valid', snapshot: fixture() });
    await expect(pending).rejects.toThrow('missing-task');
    expect(save).not.toHaveBeenCalled();
    expect(controller.getSnapshot().snapshot).toEqual(fixture());
  });
  it('serializes an explicit reset after an in-flight load so old data cannot reappear', async () => {
    let finish!: (result: { kind: 'valid'; snapshot: Snapshot }) => void;
    const save = vi.fn(async () => undefined);
    const controller = new FolderController({
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      save,
    });
    const loading = controller.load();
    const reset = controller.reset();
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
    finish({ kind: 'valid', snapshot: fixture() });
    await Promise.all([loading, reset]);
    expect(save).toHaveBeenCalledWith(emptySnapshot());
    expect(controller.getSnapshot().snapshot).toEqual(emptySnapshot());
  });
  it('makes identical moves no-ops with no revision or save', async () => {
    const save = vi.fn(async () => undefined);
    const controller = new FolderController({
      load: async () => ({ kind: 'valid', snapshot: fixture() }),
      save,
    });
    controller.setCatalog([identity]);
    await controller.load();
    await controller.execute({ type: 'moveTask', identity, parent: 'b', anchor: append });
    expect(save).not.toHaveBeenCalled();
    expect(controller.getSnapshot().snapshot.revision).toBe(3);
  });
  it.each(['{', '{"version":2}', 'null', ''])(
    'preserves invalid or unsupported stored bytes (%s)',
    async (raw) => {
      const storage = { getItem: () => raw, setItem: vi.fn() };
      const repository = new BrowserFolderRepository(() => storage);
      const controller = new FolderController(repository);
      await controller.load();
      await expect(
        controller.execute({ type: 'create', id: 'x', name: 'X', parent: null })
      ).rejects.toThrow('read-only');
      expect(storage.setItem).not.toHaveBeenCalled();
      await controller.reset();
      expect(storage.setItem).toHaveBeenCalledWith(
        FOLDERS_STORAGE_KEY,
        JSON.stringify(emptySnapshot())
      );
    }
  );
  it('reports unavailable reads and quota writes instead of replacing saved data', async () => {
    const repository = new BrowserFolderRepository(() => {
      throw Error('denied');
    });
    expect(await repository.load()).toEqual({ kind: 'unavailable' });
    await expect(repository.save(fixture())).rejects.toThrow('denied');
  });
});
