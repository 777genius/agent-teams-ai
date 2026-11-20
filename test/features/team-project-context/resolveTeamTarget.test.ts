import { describe, expect, it } from 'vitest';

import {
  resolveTeamTarget,
  TeamTargetUnresolvedError,
  type PersistedTeamWorkContext,
  type TeamTargetPorts,
} from '../../../src/features/team-project-context/main';

const ctx = (alias: string, projectPath: string, state: 'ready' | 'reserved' = 'ready') =>
  ({ id: `id-${alias}`, projectKey: projectPath, projectPath, executionTeamName: alias, state }) as PersistedTeamWorkContext;

function ports(overrides: Partial<TeamTargetPorts> = {}): TeamTargetPorts {
  return {
    getMode: async () => 'shared',
    listContexts: async () => [],
    resolveOwnedAlias: async () => null,
    ...overrides,
  };
}

describe('resolveTeamTarget', () => {
  it('treats an ordinary team as native', async () => {
    expect(await resolveTeamTarget(ports(), 'legacy')).toEqual({ kind: 'native', team: 'legacy' });
  });

  it('resolves a per-project team to its logical target with every context', async () => {
    const contexts = [ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b', 'reserved')];
    const target = await resolveTeamTarget(
      ports({ getMode: async () => 'per_project', listContexts: async () => contexts }),
      'builders'
    );
    expect(target).toEqual({ kind: 'logical', logical: 'builders', contexts });
  });

  it('keeps a logical team without contexts logical, never native', async () => {
    const target = await resolveTeamTarget(
      ports({ getMode: async () => 'per_project', listContexts: async () => [] }),
      'builders'
    );
    expect(target.kind).toBe('logical');
  });

  it('resolves an owned project copy to its logical team and project', async () => {
    const context = ctx('ptc-a', '/p/a');
    const target = await resolveTeamTarget(
      ports({ resolveOwnedAlias: async () => ({ logicalTeamName: 'builders', context }) }),
      'ptc-a'
    );
    expect(target).toEqual({ kind: 'alias', alias: 'ptc-a', logical: 'builders', context });
  });

  it('treats a shared team that owns a contexts index as logical', async () => {
    const contexts = [ctx('ptc-a', '/p/a')];
    const target = await resolveTeamTarget(ports({ listContexts: async () => contexts }), 'old');
    expect(target).toEqual({ kind: 'logical', logical: 'old', contexts });
  });

  it('fails closed when metadata is unreadable: never native', async () => {
    const failing = ports({
      getMode: async () => {
        throw new Error('Team metadata is unreadable; refusing shared-history fallback');
      },
    });
    await expect(resolveTeamTarget(failing, 'broken')).rejects.toBeInstanceOf(TeamTargetUnresolvedError);
    await expect(resolveTeamTarget(failing, 'broken')).rejects.toMatchObject({
      statusCode: 409,
      code: 'TEAM_TARGET_UNRESOLVED',
      message: expect.stringContaining('unreadable'),
    });
  });

  it('fails closed on an ambiguous alias and on unproven context ownership', async () => {
    await expect(
      resolveTeamTarget(
        ports({
          resolveOwnedAlias: async () => {
            throw new Error('Ambiguous project runtime alias');
          },
        }),
        'ptc-a'
      )
    ).rejects.toBeInstanceOf(TeamTargetUnresolvedError);
    await expect(
      resolveTeamTarget(
        ports({
          getMode: async () => 'per_project',
          listContexts: async () => {
            throw new Error('not owned by this profile');
          },
        }),
        'builders'
      )
    ).rejects.toBeInstanceOf(TeamTargetUnresolvedError);
  });
});
