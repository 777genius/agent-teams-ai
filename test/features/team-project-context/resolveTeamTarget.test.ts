import { describe, expect, it } from 'vitest';

import {
  contextGroupOf,
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
    hasContextsIndex: async () => false,
    ...overrides,
  };
}

const unreadable = async () => {
  throw new Error('Team metadata is unreadable; refusing shared-history fallback');
};

describe('resolveTeamTarget', () => {
  it('treats an ordinary team as native with nothing retained', async () => {
    expect(await resolveTeamTarget(ports(), 'legacy')).toEqual({
      kind: 'native',
      team: 'legacy',
      retained: [],
    });
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

  it('keeps a shared team native even when it retained contexts: its own name is still a process', async () => {
    const contexts = [ctx('ptc-a', '/p/a')];
    const target = await resolveTeamTarget(ports({ listContexts: async () => contexts }), 'old');
    expect(target).toEqual({ kind: 'native', team: 'old', retained: contexts });
  });

  it('asks for retained contexts of a shared team in its own mode, never as per-project', async () => {
    const seen: string[] = [];
    await resolveTeamTarget(
      ports({
        listContexts: async (_team, mode) => {
          seen.push(mode);
          return [];
        },
      }),
      'old'
    );
    expect(seen).toEqual(['shared']);
  });

  it('does not look up an ordinary or copy name as an alias: a copy is a native team', async () => {
    const target = await resolveTeamTarget(ports(), 'ptc-a1b2c3d4e5f6');
    expect(target).toMatchObject({ kind: 'native', team: 'ptc-a1b2c3d4e5f6' });
  });

  it('fails closed when metadata is unreadable and the team owns a contexts index', async () => {
    const failing = ports({ getMode: unreadable, hasContextsIndex: async () => true });
    await expect(resolveTeamTarget(failing, 'broken')).rejects.toBeInstanceOf(TeamTargetUnresolvedError);
    await expect(resolveTeamTarget(failing, 'broken')).rejects.toMatchObject({
      statusCode: 409,
      code: 'TEAM_TARGET_UNRESOLVED',
      message: expect.stringContaining('unreadable'),
    });
  });

  it('falls back to the exact name when metadata is unreadable but no contexts index exists', async () => {
    const target = await resolveTeamTarget(ports({ getMode: unreadable }), 'broken');
    expect(target).toEqual({
      kind: 'native',
      team: 'broken',
      retained: [],
      projectContextUnresolved: true,
    });
  });

  it('fails closed when it cannot even tell whether a contexts index exists', async () => {
    await expect(
      resolveTeamTarget(
        ports({
          getMode: unreadable,
          hasContextsIndex: async () => {
            throw new Error('EACCES');
          },
        }),
        'broken'
      )
    ).rejects.toBeInstanceOf(TeamTargetUnresolvedError);
  });

  it('fails closed on unproven context ownership, for per-project and for shared teams', async () => {
    const notOwned = async () => {
      throw new Error('not owned by this profile');
    };
    await expect(
      resolveTeamTarget(ports({ getMode: async () => 'per_project', listContexts: notOwned }), 'builders')
    ).rejects.toBeInstanceOf(TeamTargetUnresolvedError);
    await expect(
      resolveTeamTarget(ports({ listContexts: notOwned }), 'old')
    ).rejects.toBeInstanceOf(TeamTargetUnresolvedError);
  });
});

describe('contextGroupOf', () => {
  it('groups the contexts of a logical team under its name', () => {
    const contexts = [ctx('ptc-a', '/p/a')];
    expect(contextGroupOf({ kind: 'logical', logical: 'builders', contexts })).toEqual({
      team: 'builders',
      contexts,
    });
  });

  it('groups the retained contexts of a native team and has no group for one without', () => {
    const contexts = [ctx('ptc-a', '/p/a')];
    expect(contextGroupOf({ kind: 'native', team: 'old', retained: contexts })).toEqual({
      team: 'old',
      contexts,
    });
    expect(contextGroupOf({ kind: 'native', team: 'plain', retained: [] })).toBeNull();
  });
});
