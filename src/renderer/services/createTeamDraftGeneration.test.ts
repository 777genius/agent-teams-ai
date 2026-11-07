import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
  del: vi.fn(async (key: string) => { store.delete(key); }),
  keys: vi.fn(async () => [...store.keys()]),
}));

import { createTeamDraftStorage } from './createTeamDraftStorage';
import {
  currentCreateTeamDraftGeneration,
  isCreateTeamDraftGenerationCurrent,
  retireCreateTeamDraftGeneration,
} from './createTeamDraftGeneration';
import { draftStorage } from './draftStorage';
import { resetCreateTeamDraft } from './resetCreateTeamDraft';

describe('creation draft generation fence', () => {
  beforeEach(() => store.clear());

  it('does not allow a retired editor to recreate its snapshot or text fields', async () => {
    const old = currentCreateTeamDraftGeneration();
    const draft = createTeamDraftStorage.emptySnapshot();
    draft.teamName = 'old-copy';
    await createTeamDraftStorage.saveSnapshot(draft, old);
    await draftStorage.saveDraft('createTeam:prompt', 'old prompt', old);

    await resetCreateTeamDraft();
    expect(isCreateTeamDraftGenerationCurrent(old)).toBe(false);

    // The old component unmounts after the replacement has already started.
    await createTeamDraftStorage.saveSnapshot(draft, old);
    await draftStorage.saveDraft('createTeam:prompt', 'late old prompt', old);
    await draftStorage.saveDraft('createTeam:description', 'late description', old);
    await draftStorage.saveDraft('createTeam:prompt:chips', '[]', old);

    expect(await createTeamDraftStorage.loadSnapshot()).toBeNull();
    expect(await draftStorage.loadDraft('createTeam:prompt')).toBeNull();
    expect(await draftStorage.loadDraft('createTeam:description')).toBeNull();
    expect(await draftStorage.loadDraft('createTeam:prompt:chips')).toBeNull();
  });

  it('lets a new editor persist after replacement without affecting other drafts', async () => {
    await draftStorage.saveDraft('composer:other', 'keep this');
    const old = currentCreateTeamDraftGeneration();
    await resetCreateTeamDraft();
    const fresh = currentCreateTeamDraftGeneration();
    expect(fresh).not.toBe(old);

    const draft = createTeamDraftStorage.emptySnapshot();
    draft.teamName = 'new-copy';
    await createTeamDraftStorage.saveSnapshot(draft, fresh);
    await draftStorage.saveDraft('createTeam:prompt', 'new prompt', fresh);
    await draftStorage.deleteDraft('createTeam:prompt', old);

    expect((await createTeamDraftStorage.loadSnapshot())?.teamName).toBe('new-copy');
    expect(await draftStorage.loadDraft('createTeam:prompt')).toBe('new prompt');
    expect(await draftStorage.loadDraft('composer:other')).toBe('keep this');
  });
});
