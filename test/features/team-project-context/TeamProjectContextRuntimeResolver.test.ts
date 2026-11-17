import { describe, expect, it, vi } from 'vitest';

import { TeamProjectContextRuntimeResolver } from '../../../src/features/team-project-context/main/TeamProjectContextRuntimeResolver';

import type { TeamMetaFile } from '../../../src/main/services/team/TeamMetaStore';
import type { PersistedTeamWorkContext } from '../../../src/features/team-project-context/main';

const record: PersistedTeamWorkContext = {
  id: 'a1111111-1111-4111-a111-111111111111',
  projectKey: '/projects/a',
  projectPath: '/projects/a',
  executionTeamName: 'ptc-a111111111111111',
  state: 'ready',
};

function fixture(meta: TeamMetaFile | null, found: PersistedTeamWorkContext | null) {
  const reader = { getMeta: vi.fn(async () => meta) };
  const registry = {
    find: vi.fn(async () => found),
    reserve: vi.fn(async () => ({ ...record, state: 'reserved' as const })),
    releaseUnusedReservation: vi.fn(async () => true),
    confirmReady: vi.fn(async () => record),
  };
  return { resolver: new TeamProjectContextRuntimeResolver(reader, registry), registry };
}

describe('TeamProjectContextRuntimeResolver', () => {
  it('keeps persisted legacy teams on the original native team', async () => {
    const f = fixture(null, null);
    expect(await f.resolver.forRead({ logicalTeamName: 'existing-team' })).toEqual({
      logicalTeamName: 'existing-team',
      executionTeamName: 'existing-team',
      mode: 'shared',
      state: 'ready',
    });
    expect(f.registry.find).not.toHaveBeenCalled();
    expect(f.registry.reserve).not.toHaveBeenCalled();
  });

  it('never creates a context during a read-only team selection', async () => {
    const f = fixture({
      version: 1, cwd: '/projects/a', createdAt: 1, projectContextMode: 'per_project',
    }, null);
    expect(await f.resolver.forRead({ logicalTeamName: 'new-team', projectPath: '/projects/b' }))
      .toBeNull();
    expect(f.registry.reserve).not.toHaveBeenCalled();
  });

  it('requires project selection and resolves only an existing project context', async () => {
    const f = fixture({
      version: 1, cwd: '/projects/a', createdAt: 1, projectContextMode: 'per_project',
    }, record);
    await expect(f.resolver.forRead({ logicalTeamName: 'new-team' }))
      .rejects.toThrow('Select a project');
    expect(await f.resolver.forRead({ logicalTeamName: 'new-team', projectPath: '/projects/a' }))
      .toMatchObject({ executionTeamName: record.executionTeamName, workContextId: record.id });
  });

  it('reserves without assuming native runtime is ready', async () => {
    const f = fixture({
      version: 1, cwd: '/projects/a', createdAt: 1, projectContextMode: 'per_project',
    }, record);
    const result = await f.resolver.reserveForProvisioning({
      logicalTeamName: 'new-team', projectPath: '/projects/b',
    });
    expect(result.state).toBe('reserved');
    expect(f.registry.reserve).toHaveBeenCalledWith('new-team', '/projects/b');
  });

  it('rejects corrupted explicit mode rather than falling back to shared', async () => {
    const f = fixture({
      version: 1, cwd: '/projects/a', createdAt: 1, projectContextMode: 'not-real' as never,
    }, null);
    await expect(f.resolver.forRead({ logicalTeamName: 'new-team' }))
      .rejects.toThrow('Invalid persisted');
  });
});
