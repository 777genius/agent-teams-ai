import { beforeEach, describe, expect, it, vi } from 'vitest';

const atomicWriteAsync = vi.hoisted(() =>
  vi.fn(async (_path: string, _content: string) => undefined)
);

vi.mock('../atomicWrite', () => ({ atomicWriteAsync }));

import { TeamMetaStore } from '../TeamMetaStore';

import type { TeamMetaFile } from '../TeamMetaStore';

const initialMeta: TeamMetaFile = {
  version: 1,
  cwd: '/sandbox/team',
  model: 'old-model',
  effort: 'low',
  createdAt: 1,
};

describe('TeamMetaStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes writes behind an in-flight metadata read-modify-write', async () => {
    const updatingStore = new TeamMetaStore();
    const writingStore = new TeamMetaStore();
    vi.spyOn(updatingStore, 'getMeta').mockResolvedValue(initialMeta);
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let updateRead!: () => void;
    const updateReadSignal = new Promise<void>((resolve) => {
      updateRead = resolve;
    });
    const update = updatingStore.updateMeta('alpha', async (current) => {
      updateRead();
      await updateGate;
      if (!current) throw new Error('missing metadata');
      return { ...current, model: 'new-model', effort: 'high' };
    });
    await updateReadSignal;

    const write = writingStore.writeMeta('alpha', {
      cwd: '/sandbox/team',
      model: 'other-model',
      effort: 'medium',
      createdAt: 1,
    });
    await Promise.resolve();
    expect(atomicWriteAsync).not.toHaveBeenCalled();

    releaseUpdate();
    await Promise.all([update, write]);

    expect(atomicWriteAsync).toHaveBeenCalledTimes(2);
    expect(JSON.parse(atomicWriteAsync.mock.calls[0]?.[1] as string)).toMatchObject({
      model: 'new-model',
      effort: 'high',
    });
    expect(JSON.parse(atomicWriteAsync.mock.calls[1]?.[1] as string)).toMatchObject({
      model: 'other-model',
      effort: 'medium',
    });
  });
});
