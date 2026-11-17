import { describe, expect, it, vi } from 'vitest';

import { TeamProjectContextDraftMaterializer } from '../../../src/features/team-project-context/main/TeamProjectContextDraftMaterializer';

import type { ResolvedTeamWorkContext } from '../../../src/features/team-project-context/main';

const reserved: ResolvedTeamWorkContext = {
  mode: 'per_project',
  logicalTeamName: 'builders',
  executionTeamName: 'ptc-sandbox',
  workContextId: '11111111-1111-4111-8111-111111111111',
  projectPath: '/sandbox/b',
  state: 'reserved',
};

function fixture(result: ResolvedTeamWorkContext = reserved) {
  const context = { reserveForProvisioning: vi.fn(async () => result) };
  const store = {
    getSavedRequest: vi.fn(async (name: string) =>
      name === 'builders'
        ? { teamName: 'builders', cwd: '/sandbox/a', members: [{ name: 'alice' }], prompt: 'rules' }
        : null),
    createTeamConfig: vi.fn(async () => undefined),
    assertOwnedAlias: vi.fn(async () => undefined),
  };
  const claim = vi.fn(async () => undefined);
  return { materializer: new TeamProjectContextDraftMaterializer(context, store, claim), store, claim };
}

describe('TeamProjectContextDraftMaterializer', () => {
  it('builds a fresh, native-compatible draft from logical settings and the chosen project', async () => {
    const f = fixture();
    const got = await f.materializer.ensureProjectDraft({
      logicalTeamName: 'builders', projectPath: '/sandbox/b',
    });
    expect(got).toEqual(reserved);
    expect(f.store.createTeamConfig).toHaveBeenCalledWith({
      teamName: 'ptc-sandbox', cwd: '/sandbox/b', members: [{ name: 'alice' }],
      prompt: 'rules', projectContextMode: 'shared',
    });
    expect(f.claim).toHaveBeenCalledWith('ptc-sandbox');
  });

  it('does not create a second draft for an existing owned alias', async () => {
    const f = fixture();
    f.store.getSavedRequest.mockImplementation(async (name) =>
      name === 'ptc-sandbox'
        ? { teamName: 'ptc-sandbox', cwd: '/sandbox/b', members: [] }
        : { teamName: 'builders', cwd: '/sandbox/a', members: [] }
    );
    await f.materializer.ensureProjectDraft({
      logicalTeamName: 'builders', projectPath: '/sandbox/b',
    });
    expect(f.store.assertOwnedAlias).toHaveBeenCalledWith('ptc-sandbox');
    expect(f.store.createTeamConfig).not.toHaveBeenCalled();
    expect(f.claim).not.toHaveBeenCalled();
  });

  it('leaves legacy shared teams on existing team paths with no second draft', async () => {
    const f = fixture({
      mode: 'shared', logicalTeamName: 'builders', executionTeamName: 'builders', state: 'ready',
    });
    const got = await f.materializer.ensureProjectDraft({ logicalTeamName: 'builders' });
    expect(got.executionTeamName).toBe('builders');
    expect(f.store.createTeamConfig).not.toHaveBeenCalled();
  });

  it('never starts a native team or claims a foreign preexisting alias', async () => {
    const f = fixture();
    f.store.getSavedRequest.mockImplementation(async () => ({
      teamName: 'ptc-sandbox', cwd: '/sandbox/b', members: [],
    }));
    f.store.assertOwnedAlias.mockRejectedValue(new Error('foreign'));
    await expect(f.materializer.ensureProjectDraft({
      logicalTeamName: 'builders', projectPath: '/sandbox/b',
    })).rejects.toThrow('foreign');
    expect(f.claim).not.toHaveBeenCalled();
  });
});
