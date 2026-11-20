import { describe, expect, it, vi } from 'vitest';

import { TeamProjectContextDraftMaterializer } from '../../../src/features/team-project-context/main/TeamProjectContextDraftMaterializer';

import type { ResolvedTeamWorkContext } from '../../../src/features/team-project-context/main';
import type { TeamCreateConfigRequest } from '../../../src/shared/types/team';
import type { TeamCreateRequest } from '../../../src/shared/types/team';

const reserved: ResolvedTeamWorkContext = {
  mode: 'per_project',
  logicalTeamName: 'builders',
  executionTeamName: 'ptc-sandbox',
  workContextId: '11111111-1111-4111-8111-111111111111',
  projectPath: '/sandbox/b',
  state: 'reserved',
};

function fixture(result: ResolvedTeamWorkContext = reserved) {
  const context = {
    reserveForProvisioning: vi.fn(async () => result),
    releaseUnusedReservation: vi.fn(async () => true),
  };
  const store = {
    getSavedRequest: vi.fn(async (name: string): Promise<TeamCreateRequest | null> =>
      name === 'builders'
        ? { teamName: 'builders', cwd: '/sandbox/a', members: [{ name: 'alice' }], prompt: 'rules' }
        : null),
    createTeamConfig: vi.fn(async (_: TeamCreateConfigRequest, _options: { claimOwnerOnCreate: true }) => undefined),
    assertOwnedAlias: vi.fn(async () => undefined),
    replaceMembers: vi.fn(async () => undefined),
    updateDisplayMetadata: vi.fn(async () => undefined),
    updateLaunchSettings: vi.fn(async () => undefined),
    assertStoppedForRosterSync: vi.fn(async () => undefined),
  };
  return { materializer: new TeamProjectContextDraftMaterializer(context, store), context, store };
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
    }, { claimOwnerOnCreate: true });
  });

  it('releases an empty reservation when native draft creation rejects', async () => {
    const f = fixture();
    f.store.createTeamConfig.mockRejectedValue(new Error('disk full'));
    await expect(f.materializer.ensureProjectDraft({
      logicalTeamName: 'builders', projectPath: '/sandbox/b',
    })).rejects.toThrow('disk full');
    expect(f.context.releaseUnusedReservation).toHaveBeenCalledWith(
      'builders', 'ptc-sandbox', reserved.workContextId
    );

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

  });

  it('synchronizes an edited logical roster into a stopped ready project before launch', async () => {
    const f = fixture({ ...reserved, state: 'ready' });
    f.store.getSavedRequest.mockImplementation(async (name) =>
      name === 'builders'
        ? {
            teamName: 'builders', cwd: '/sandbox/b',
            members: [{ name: 'alice', role: 'new role' }, { name: 'bob' }],
          }
        : {
            teamName: 'ptc-sandbox', cwd: '/sandbox/b',
            members: [{ name: 'alice', role: 'old role' }],
          }
    );
    const result = await f.materializer.ensureProjectDraft({
      logicalTeamName: 'builders', projectPath: '/sandbox/b',
    });
    expect(result.state).toBe('ready');
    expect(f.store.assertOwnedAlias).toHaveBeenCalledWith('ptc-sandbox');
    expect(f.store.assertStoppedForRosterSync).toHaveBeenCalledWith('ptc-sandbox');
    expect(f.store.replaceMembers).toHaveBeenCalledOnce();
    expect(f.store.replaceMembers).toHaveBeenCalledWith('ptc-sandbox', {
      members: [{ name: 'alice', role: 'new role' }, { name: 'bob' }],
    });
    expect(f.store.createTeamConfig).not.toHaveBeenCalled();
  });

  it('projects the logical description and color onto a stopped ready project at launch', async () => {
    const f = fixture({ ...reserved, state: 'ready' });
    f.store.getSavedRequest.mockImplementation(async (name) => ({
      teamName: name,
      cwd: '/sandbox/b',
      members: [{ name: 'alice' }],
      ...(name === 'builders'
        ? { description: 'New description', color: 'green' }
        : { description: 'Old description', color: 'blue' }),
    }));
    await f.materializer.ensureProjectDraft({
      logicalTeamName: 'builders', projectPath: '/sandbox/b',
    });
    expect(f.store.assertStoppedForRosterSync).toHaveBeenCalledWith('ptc-sandbox');
    expect(f.store.updateDisplayMetadata).toHaveBeenCalledWith('ptc-sandbox', {
      description: 'New description',
      color: 'green',
    });
    expect(f.store.replaceMembers).not.toHaveBeenCalled();
  });

  it('repairs a stale saved lead prompt of a stopped ready project at launch', async () => {
    const f = fixture({ ...reserved, state: 'ready' });
    f.store.getSavedRequest.mockImplementation(async (name) => ({
      teamName: name,
      cwd: '/sandbox/b',
      members: [{ name: 'alice' }],
      prompt: name === 'builders' ? 'Edited rules' : 'Rules typed at an old launch',
    }));
    await f.materializer.ensureProjectDraft({
      logicalTeamName: 'builders', projectPath: '/sandbox/b',
    });
    expect(f.store.assertStoppedForRosterSync).toHaveBeenCalledWith('ptc-sandbox');
    expect(f.store.updateDisplayMetadata).toHaveBeenCalledWith('ptc-sandbox', {
      description: '',
      color: '',
      prompt: 'Edited rules',
    });
    expect(f.store.replaceMembers).not.toHaveBeenCalled();
  });

  it('repairs older project copies with the launch settings of the definition, without demanding a stop', async () => {
    const f = fixture({ ...reserved, state: 'ready' });
    f.store.getSavedRequest.mockImplementation(async (name) => ({
      teamName: name,
      cwd: '/sandbox/b',
      members: [{ name: 'alice' }],
      ...(name === 'builders'
        ? { providerId: 'codex' as const, model: 'gpt-x', effort: 'high' as const, skipPermissions: true }
        : { providerId: 'codex' as const, model: 'gpt-old', effort: 'high' as const, skipPermissions: false }),
    }));
    await f.materializer.ensureProjectDraft({
      logicalTeamName: 'builders', projectPath: '/sandbox/b',
    });
    expect(f.store.updateLaunchSettings).toHaveBeenCalledOnce();
    expect(f.store.updateLaunchSettings).toHaveBeenCalledWith('ptc-sandbox', { model: 'gpt-x' });
    expect(f.store.assertStoppedForRosterSync).not.toHaveBeenCalled();
    expect(f.store.replaceMembers).not.toHaveBeenCalled();
  });

  it('refuses to mutate the project roster while its runtime is still live', async () => {
    const f = fixture({ ...reserved, state: 'ready' });
    f.store.getSavedRequest.mockImplementation(async (name) => ({
      teamName: name,
      cwd: '/sandbox/b',
      members: [{ name: 'alice', role: name === 'builders' ? 'new' : 'old' }],
    }));
    f.store.assertStoppedForRosterSync.mockRejectedValue(new Error('Stop this project runtime'));
    await expect(f.materializer.ensureProjectDraft({
      logicalTeamName: 'builders', projectPath: '/sandbox/b',
    })).rejects.toThrow('Stop this project runtime');
    expect(f.store.replaceMembers).not.toHaveBeenCalled();
  });

  it('does not rewrite unchanged authored roster or runtime-only member cwd', async () => {
    const f = fixture({ ...reserved, state: 'ready' });
    f.store.getSavedRequest.mockImplementation(async (name) => ({
      teamName: name,
      cwd: '/sandbox/b',
      members: [{
        name: 'alice', role: 'developer',
        ...(name === 'ptc-sandbox' ? { cwd: '/generated/member-worktree' } : {}),
      }],
    }));
    await f.materializer.ensureProjectDraft({
      logicalTeamName: 'builders', projectPath: '/sandbox/b',
    });
    expect(f.store.replaceMembers).not.toHaveBeenCalled();
  });

  it('never mutates an unowned ready project runtime even after logical roster edits', async () => {
    const f = fixture({ ...reserved, state: 'ready' });
    f.store.assertOwnedAlias.mockRejectedValue(new Error('foreign owner'));
    await expect(f.materializer.ensureProjectDraft({
      logicalTeamName: 'builders', projectPath: '/sandbox/b',
    })).rejects.toThrow('foreign owner');
    expect(f.store.replaceMembers).not.toHaveBeenCalled();
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
  });
});
