import { describe, expect, it, vi } from 'vitest';

import { FolderController } from '../../../src/features/task-folders/core/application/folderController';
import {
  append,
  applyCommand,
  emptySnapshot,
  parentOf,
  validateSnapshot,
} from '../../../src/features/task-folders/core/domain/folders';
import {
  BrowserFolderRepository,
  FOLDERS_STORAGE_KEY,
} from '../../../src/features/task-folders/renderer/adapters/browserRepository';
import { folderChoices } from '../../../src/features/task-folders/renderer/view-models/folderChoices';

import type { Snapshot } from '../../../src/features/task-folders/core/domain/folders';
const identity = { teamName: 'team:a', taskId: 'b' };
function fixture(): Snapshot {
  let s = applyCommand(emptySnapshot(), { type: 'create', id: 'a', parent: null, name: 'A' });
  s = applyCommand(s, { type: 'create', id: 'b', parent: 'a', name: 'B' });
  return applyCommand(s, { type: 'moveTask', identity, parent: 'b', anchor: append });
}
describe('folder invariants and durable commands', () => {
  it('labels duplicate siblings in canonical root/child order rather than storage order', () => {
    let snapshot = emptySnapshot();
    snapshot = applyCommand(snapshot, { type: 'create', id: 'z', parent: null, name: 'Same' });
    snapshot = applyCommand(snapshot, { type: 'create', id: 'a', parent: null, name: 'Same' });
    snapshot.folders.reverse();
    expect(folderChoices(snapshot)).toEqual([
      { id: 'z', label: 'Same (1)' },
      { id: 'a', label: 'Same (2)' },
    ]);
  });

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
  it('retains every failed save across independent successful queued commands and retries in order', async () => {
    const save = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('quota A'))
      .mockRejectedValueOnce(new Error('quota B'));
    const controller = new FolderController({ load: async () => ({ kind: 'empty' }), save });
    const a = controller.execute({ type: 'create', id: 'a', name: 'A', parent: null });
    const b = controller.execute({ type: 'create', id: 'b', name: 'B', parent: null });
    const c = controller.execute({ type: 'create', id: 'c', name: 'C', parent: null });
    await Promise.all([
      expect(a).rejects.toThrow('quota A'),
      expect(b).rejects.toThrow('quota B'),
      c,
    ]);
    expect(controller.getSnapshot().snapshot.rootFolderIds).toEqual(['c']);
    expect(controller.getSnapshot().pending).toBe(0);
    expect(controller.getSnapshot().error).toBe('quota A');
    await Promise.all([controller.retry(), controller.retry()]);
    expect(controller.getSnapshot().snapshot.rootFolderIds).toEqual(['c', 'a']);
    expect(controller.getSnapshot().error).toBe('quota B');
    await controller.retry();
    expect(controller.getSnapshot().snapshot.rootFolderIds).toEqual(['c', 'a', 'b']);
    expect(controller.getSnapshot().error).toBeNull();
    expect(save).toHaveBeenCalledTimes(5);
  });
  it('retires only the edited rename session after a successful resubmit', async () => {
    const save = vi
      .fn(async (_snapshot: Snapshot) => undefined)
      .mockRejectedValueOnce(new Error('rename quota'))
      .mockRejectedValueOnce(new Error('independent quota'));
    const controller = new FolderController({
      load: async () => ({ kind: 'valid', snapshot: fixture() }),
      save,
    });
    await expect(
      controller.execute({ type: 'rename', id: 'a', name: 'First attempt' }, 'rename-edit')
    ).rejects.toThrow('rename quota');
    await expect(
      controller.execute({ type: 'create', id: 'other', parent: null, name: 'Other' })
    ).rejects.toThrow('independent quota');
    await controller.execute({ type: 'rename', id: 'a', name: 'Corrected name' }, 'rename-edit');
    expect(controller.getSnapshot().snapshot.folders[0].name).toBe('Corrected name');
    expect(controller.getSnapshot().error).toBe('independent quota');
    await controller.retry();
    expect(controller.getSnapshot().snapshot.folders.map((folder) => folder.name)).toEqual([
      'Corrected name',
      'B',
      'Other',
    ]);
    expect(save.mock.calls.at(-1)?.[0].folders[0].name).toBe('Corrected name');
    expect(controller.getSnapshot().error).toBeNull();
  });
  it('retires a changed-destination move retry without losing an independent failure', async () => {
    let snapshot = fixture();
    snapshot = applyCommand(snapshot, {
      type: 'create',
      id: 'x',
      parent: null,
      name: 'X',
    });
    const save = vi
      .fn(async (_snapshot: Snapshot) => undefined)
      .mockRejectedValueOnce(new Error('move quota'))
      .mockRejectedValueOnce(new Error('independent quota'));
    const controller = new FolderController({
      load: async () => ({ kind: 'valid', snapshot }),
      save,
    });
    await expect(
      controller.execute(
        { type: 'moveFolder', id: 'b', parent: null, anchor: append },
        'dialog-move'
      )
    ).rejects.toThrow('move quota');
    await expect(
      controller.execute({
        type: 'create',
        id: 'independent',
        parent: null,
        name: 'Independent',
      })
    ).rejects.toThrow('independent quota');
    await controller.execute(
      { type: 'moveFolder', id: 'b', parent: 'x', anchor: append },
      'dialog-move'
    );
    expect(parentOf(controller.getSnapshot().snapshot, 'b')).toBe('x');
    expect(controller.getSnapshot().error).toBe('independent quota');

    await controller.retry();
    expect(parentOf(controller.getSnapshot().snapshot, 'b')).toBe('x');
    expect(controller.getSnapshot().snapshot.rootFolderIds).toEqual(['a', 'x', 'independent']);
    expect(controller.getSnapshot().error).toBeNull();
    await controller.retry();
    expect(save).toHaveBeenCalledTimes(4);
  });
  it('supersedes queued submissions with one operation ID instead of retaining duplicate retries', async () => {
    let snapshot = fixture();
    snapshot = applyCommand(snapshot, { type: 'create', id: 'x', parent: null, name: 'X' });
    const save = vi
      .fn(async (_snapshot: Snapshot) => undefined)
      .mockRejectedValueOnce(new Error('quota'));
    const controller = new FolderController({
      load: async () => ({ kind: 'valid', snapshot }),
      save,
    });
    const stale = controller.execute(
      { type: 'moveFolder', id: 'b', parent: null, anchor: append },
      'dialog-move'
    );
    const current = controller.execute(
      { type: 'moveFolder', id: 'b', parent: 'x', anchor: append },
      'dialog-move'
    );
    await expect(stale).rejects.toThrow('quota');
    await current;
    expect(parentOf(controller.getSnapshot().snapshot, 'b')).toBe('x');
    expect(controller.getSnapshot().error).toBeNull();
    await controller.retry();
    expect(save).toHaveBeenCalledTimes(2);
    expect(parentOf(controller.getSnapshot().snapshot, 'b')).toBe('x');
  });
  it('executes a new valid manual command after an invalid same-operation predecessor retires a failure', async () => {
    const save = vi.fn(async () => undefined);
    const controller = new FolderController({
      load: async () => ({ kind: 'empty' }),
      save,
    });
    await controller.execute({ type: 'create', id: 'original', parent: null, name: 'Original' });
    save.mockRejectedValueOnce(new Error('quota'));
    await expect(
      controller.execute({ type: 'rename', id: 'original', name: 'Failed' }, 'workflow')
    ).rejects.toThrow('quota');

    const invalid = controller.execute({ type: 'rename', id: 'original', name: '' }, 'workflow');
    const valid = controller.execute(
      { type: 'rename', id: 'original', name: 'Latest' },
      'workflow'
    );
    const [invalidResult, validResult] = await Promise.allSettled([invalid, valid]);

    expect(invalidResult.status).toBe('rejected');
    expect((invalidResult as PromiseRejectedResult).reason).toMatchObject({ message: 'name' });
    expect(validResult.status).toBe('fulfilled');
    expect(controller.getSnapshot().snapshot).toMatchObject({
      revision: 2,
      folders: [{ id: 'original', name: 'Latest', children: [] }],
    });
    expect(controller.getSnapshot().error).toBeNull();
    expect(save).toHaveBeenCalledTimes(3);
  });
  it('preserves an empty explicit operation identity when retiring a failed edit', async () => {
    const save = vi
      .fn(async (_snapshot: Snapshot) => undefined)
      .mockRejectedValueOnce(new Error('rename quota'));
    const controller = new FolderController({
      load: async () => ({ kind: 'valid', snapshot: fixture() }),
      save,
    });
    await expect(
      controller.execute({ type: 'rename', id: 'a', name: 'First attempt' }, '')
    ).rejects.toThrow('rename quota');
    await controller.execute({ type: 'rename', id: 'a', name: 'Corrected name' }, '');
    expect(controller.getSnapshot().error).toBeNull();
    await controller.retry();
    expect(save).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().snapshot.folders[0].name).toBe('Corrected name');
  });
  it('does not offer storage Retry for repeated validation failures or overwrite an earlier save failure', async () => {
    const save = vi.fn(async () => undefined);
    const controller = new FolderController({
      load: async () => ({ kind: 'valid', snapshot: fixture() }),
      save,
    });
    await controller.load();
    const invalid = [
      { type: 'moveFolder', id: 'a', parent: 'b', anchor: append },
      { type: 'rename', id: 'a', name: '' },
      { type: 'moveTask', identity, parent: 'a', anchor: append },
    ] as const;
    for (const command of invalid) {
      await expect(controller.execute(command)).rejects.toThrow();
      await expect(controller.execute(command)).rejects.toThrow();
      expect(controller.getSnapshot().error).toBeNull();
      await controller.retry();
    }
    expect(save).not.toHaveBeenCalled();
    save.mockRejectedValueOnce(new Error('quota'));
    await expect(controller.execute({ type: 'rename', id: 'a', name: 'Changed' })).rejects.toThrow(
      'quota'
    );
    await expect(controller.execute(invalid[0])).rejects.toThrow('cycle');
    expect(controller.getSnapshot().error).toBe('quota');
    await controller.retry();
    expect(controller.getSnapshot().snapshot.folders[0].name).toBe('Changed');
    expect(controller.getSnapshot().error).toBeNull();
  });
  it('retires a failed save that becomes invalid before retry without trying storage again', async () => {
    const save = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('quota'));
    const controller = new FolderController({
      load: async () => ({ kind: 'valid', snapshot: fixture() }),
      save,
    });
    controller.setCatalog([identity]);
    await expect(
      controller.execute({ type: 'moveTask', identity, parent: 'a', anchor: append })
    ).rejects.toThrow('quota');
    controller.setCatalog([]);
    await expect(controller.retry()).rejects.toThrow('missing-task');
    expect(controller.getSnapshot().error).toBeNull();
    await controller.retry();
    expect(save).toHaveBeenCalledTimes(1);
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
      expect(controller.getSnapshot().error).toBeNull();
      await controller.retry();
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
