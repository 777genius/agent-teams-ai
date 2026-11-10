import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  current: null as unknown,
  pendingSave: null as Promise<void> | null,
  calls: [] as string[],
}));

vi.mock('idb-keyval', () => ({
  get: vi.fn(async () => state.current),
  set: vi.fn(async (_key: string, value: unknown) => {
    state.calls.push('set');
    await state.pendingSave;
    state.current = value;
  }),
  del: vi.fn(async () => {
    state.calls.push('del');
    state.current = null;
  }),
}));

import { createTeamDraftStorage } from './createTeamDraftStorage';

describe('create-team draft mutation ordering', () => {
  beforeEach(() => {
    state.current = null;
    state.pendingSave = null;
    state.calls = [];
  });

  it('cannot resurrect a completed draft with an earlier delayed save', async () => {
    let releaseSave!: () => void;
    state.pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const draft = createTeamDraftStorage.emptySnapshot();
    draft.teamName = 'unsaved-team';

    const save = createTeamDraftStorage.saveSnapshot(draft);
    const remove = createTeamDraftStorage.deleteSnapshot();

    // Both operations are queued; the earlier slow save must settle first.
    await Promise.resolve();
    releaseSave();
    await Promise.all([save, remove]);

    expect(state.calls).toEqual(['set', 'del']);
    expect(await createTeamDraftStorage.loadSnapshot()).toBeNull();
  });
});
