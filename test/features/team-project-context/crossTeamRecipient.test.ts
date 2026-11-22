import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCrossTeamRecipientPorts,
  CrossTeamRecipientError,
  resolveCrossTeamRecipient,
  TeamProjectContextRegistry,
} from '../../../src/features/team-project-context/main';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { TeamMetaStore } from '../../../src/main/services/team/TeamMetaStore';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * One per-project team `builders` with history in projects A and B, a launch in
 * progress in project C, and nothing in project D; an ordinary team `partner`.
 * Everything is read through the real metadata store and registry.
 */
async function world() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cross-team-recipient-')));
  roots.push(root);
  const teamsBasePath = path.join(root, 'teams');
  const tasksBasePath = path.join(root, 'tasks');
  const project = (id: string) => path.join(root, 'projects', id);
  await Promise.all(
    [teamsBasePath, tasksBasePath, ...['a', 'b', 'c', 'd'].map(project)].map((dir) =>
      mkdir(dir, { recursive: true })
    )
  );
  const profileScope = 'cross-team-profile';
  const registry = new TeamProjectContextRegistry({ teamsBasePath, tasksBasePath, profileScope });
  const claim = (teamName: string) =>
    claimTeamForThisProfile({ teamsBasePath, teamName, reason: 'create', profileScope });
  const writeMeta = async (teamName: string, body: string) => {
    await mkdir(path.join(teamsBasePath, teamName), { recursive: true });
    await writeFile(path.join(teamsBasePath, teamName, 'team.meta.json'), body);
    await claim(teamName);
  };
  const meta = (mode: string) =>
    JSON.stringify({ version: 1, cwd: '/x', createdAt: 1, projectContextMode: mode });
  await writeMeta('builders', meta('per_project'));
  await writeMeta('partner', meta('shared'));
  await writeMeta('reviewers', meta('per_project'));

  /** A copy of a per-project team for one project, `ready` unless asked to stay pending. */
  const copyOf = async (team: string, id: string, ready = true): Promise<string> => {
    await mkdir(project(id), { recursive: true });
    const reserved = await registry.reserve(team, project(id));
    if (!ready) return reserved.executionTeamName;
    await mkdir(path.join(teamsBasePath, reserved.executionTeamName), { recursive: true });
    await mkdir(path.join(tasksBasePath, reserved.executionTeamName), { recursive: true });
    await writeFile(
      path.join(teamsBasePath, reserved.executionTeamName, 'config.json'),
      JSON.stringify({ name: reserved.executionTeamName, projectPath: project(id) })
    );
    await claim(reserved.executionTeamName);
    await registry.confirmReady(team, project(id), reserved.executionTeamName);
    return reserved.executionTeamName;
  };
  const copies = {
    a: await copyOf('builders', 'a'),
    b: await copyOf('builders', 'b'),
    c: await copyOf('builders', 'c', false),
  };

  const store = new TeamMetaStore();
  const ports = createCrossTeamRecipientPorts(
    {
      getMeta: (name) => store.getMeta(name, teamsBasePath),
      metadataFileExists: (name) => store.metadataFileExists(name, teamsBasePath),
    },
    registry
  );
  const indexPath = path.join(teamsBasePath, 'builders', 'project-contexts.json');
  return { root, teamsBasePath, registry, ports, project, copies, copyOf, indexPath, writeMeta };
}

async function refusal(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof CrossTeamRecipientError)
      return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('Expected a refusal');
}

describe('resolveCrossTeamRecipient', () => {
  it('keeps the exact name of an ordinary team and of a project copy', async () => {
    const w = await world();
    await expect(
      resolveCrossTeamRecipient(w.ports, { fromTeam: 'builders-x', toTeam: 'partner' })
    ).resolves.toEqual({ teamName: 'partner' });
    // A copy stays addressable by its exact name: replies to `ptc-….lead` must reach that copy.
    await expect(
      resolveCrossTeamRecipient(w.ports, { fromTeam: 'partner', toTeam: w.copies.b })
    ).resolves.toEqual({ teamName: w.copies.b });
  });

  it('refuses an exact copy if its project mapping changes during lookup', async () => {
    const w = await world();
    const disappeared = { ...w.ports, inspectContext: async () => null };
    await expect(resolveCrossTeamRecipient(disappeared, { fromTeam: 'partner', toTeam: w.copies.a }))
      .rejects.toMatchObject({ code: 'UNRESOLVED' });
    const replaced = {
      ...w.ports,
      inspectContext: async () => ({
        id: 'other', projectKey: w.project('a'), projectPath: w.project('a'),
        executionTeamName: w.copies.b, state: 'ready' as const,
      }),
    };
    await expect(resolveCrossTeamRecipient(replaced, { fromTeam: 'partner', toTeam: w.copies.a }))
      .rejects.toMatchObject({ code: 'UNRESOLVED' });
  });

  it('refuses an exact copy name of the sender team and of a copy still being launched', async () => {
    const w = await world();
    // Project A's copy cannot write into project B's history of the same team.
    const sibling = await refusal(
      resolveCrossTeamRecipient(w.ports, { fromTeam: w.copies.a, toTeam: w.copies.b })
    );
    expect(sibling.code).toBe('SAME_TEAM');
    const pending = await refusal(
      resolveCrossTeamRecipient(w.ports, { fromTeam: 'partner', toTeam: w.copies.c })
    );
    expect(pending.code).toBe('PROJECT_LAUNCH_PENDING');
  });

  it('delivers to the copy of the sender project and never to the copy of another project', async () => {
    const w = await world();
    const toA = await resolveCrossTeamRecipient(w.ports, {
      fromTeam: 'partner',
      toTeam: 'builders',
      senderProjectPath: w.project('a'),
    });
    const toB = await resolveCrossTeamRecipient(w.ports, {
      fromTeam: 'partner',
      toTeam: 'builders',
      senderProjectPath: w.project('b'),
    });
    expect(toA).toEqual({
      teamName: w.copies.a,
      logicalTeamName: 'builders',
      projectPath: w.project('a'),
    });
    expect(toB).toEqual({
      teamName: w.copies.b,
      logicalTeamName: 'builders',
      projectPath: w.project('b'),
    });
    expect(toA.teamName).not.toBe(toB.teamName);
  });

  it('routes a project copy that sends to another per-project team by the copy project', async () => {
    const w = await world();
    const reviewersA = await w.copyOf('reviewers', 'a');
    await expect(
      resolveCrossTeamRecipient(w.ports, {
        fromTeam: w.copies.a,
        toTeam: 'reviewers',
        senderProjectPath: w.project('a'),
      })
    ).resolves.toMatchObject({ teamName: reviewersA });
    // From project B the same team has no history yet.
    expect(
      (
        await refusal(
          resolveCrossTeamRecipient(w.ports, {
            fromTeam: w.copies.b,
            toTeam: 'reviewers',
            senderProjectPath: w.project('b'),
          })
        )
      ).code
    ).toBe('NO_PROJECT_HISTORY');
  });

  it('refuses a project without history and does not create a context for it', async () => {
    const w = await world();
    const before = await readFile(w.indexPath, 'utf8');
    const result = await refusal(
      resolveCrossTeamRecipient(w.ports, {
        fromTeam: 'partner',
        toTeam: 'builders',
        senderProjectPath: w.project('d'),
      })
    );
    expect(result.code).toBe('NO_PROJECT_HISTORY');
    expect(result.message).toContain('"builders"');
    expect(result.message).toContain(w.project('d'));
    expect(result.message).toContain('launch it');
    expect(await readFile(w.indexPath, 'utf8')).toBe(before);
  });

  it('refuses while a launch in the sender project is still pending', async () => {
    const w = await world();
    const result = await refusal(
      resolveCrossTeamRecipient(w.ports, {
        fromTeam: 'partner',
        toTeam: 'builders',
        senderProjectPath: w.project('c'),
      })
    );
    expect(result.code).toBe('PROJECT_LAUNCH_PENDING');
  });

  it('refuses when the sender has no project to choose a copy by', async () => {
    const w = await world();
    for (const senderProjectPath of [undefined, null, '  ']) {
      const result = await refusal(
        resolveCrossTeamRecipient(w.ports, {
          fromTeam: 'partner',
          toTeam: 'builders',
          senderProjectPath,
        })
      );
      expect(result.code).toBe('SENDER_PROJECT_UNKNOWN');
    }
  });

  it('refuses a per-project team as the sender: it has no inbox or process of its own', async () => {
    const w = await world();
    const result = await refusal(
      resolveCrossTeamRecipient(w.ports, {
        fromTeam: 'builders',
        toTeam: 'partner',
        senderProjectPath: w.project('a'),
      })
    );
    expect(result.code).toBe('SENDER_IS_PROJECT_TEAM');
  });

  it('refuses a copy that addresses its own per-project team', async () => {
    const w = await world();
    const result = await refusal(
      resolveCrossTeamRecipient(w.ports, {
        fromTeam: w.copies.a,
        toTeam: 'builders',
        senderProjectPath: w.project('a'),
      })
    );
    expect(result.code).toBe('SAME_TEAM');
  });

  it('fails closed on unreadable metadata and on a team being moved to trash', async () => {
    const w = await world();
    await w.writeMeta('broken', '{not json');
    await expect(
      resolveCrossTeamRecipient(w.ports, { fromTeam: 'partner', toTeam: 'broken' })
    ).rejects.toThrow('Team metadata is unreadable; refusing cross-team delivery');

    await w.registry.beginSoftDelete('builders');
    const result = await refusal(
      resolveCrossTeamRecipient(w.ports, {
        fromTeam: 'partner',
        toTeam: 'builders',
        senderProjectPath: w.project('a'),
      })
    );
    expect(result.code).toBe('UNRESOLVED');
    // Its copies named exactly are refused the same way, with the reason.
    const byCopyName = await refusal(
      resolveCrossTeamRecipient(w.ports, { fromTeam: 'partner', toTeam: w.copies.b })
    );
    expect(byCopyName.code).toBe('UNRESOLVED');
    expect(byCopyName.message).toContain('moved to trash');
  });

  it('refuses messages to copies while any contexts index is damaged (deliberate)', async () => {
    const w = await world();
    await w.writeMeta(
      'damaged',
      JSON.stringify({ version: 1, cwd: '/x', createdAt: 1, projectContextMode: 'per_project' })
    );
    await writeFile(path.join(w.teamsBasePath, 'damaged', 'project-contexts.json'), '{not json');
    // An unproven owner could be the sender's own team, so a copy name is refused...
    const toCopy = await refusal(
      resolveCrossTeamRecipient(w.ports, { fromTeam: 'partner', toTeam: w.copies.b })
    );
    expect(toCopy.code).toBe('UNRESOLVED');
    // ...while a name that is not shaped like a copy is never scanned and still works.
    await expect(
      resolveCrossTeamRecipient(w.ports, { fromTeam: w.copies.a, toTeam: 'partner' })
    ).resolves.toEqual({ teamName: 'partner' });
  });

  it('finds the copy through a symlinked project path and keeps folders of the same name apart', async () => {
    const w = await world();
    const link = path.join(w.root, 'link-to-a');
    await symlink(w.project('a'), link, 'junction');
    await expect(
      resolveCrossTeamRecipient(w.ports, {
        fromTeam: 'partner',
        toTeam: 'builders',
        senderProjectPath: link,
      })
    ).resolves.toMatchObject({ teamName: w.copies.a });

    const one = await w.copyOf('reviewers', 'one/app');
    const two = await w.copyOf('reviewers', 'two/app');
    for (const [id, copy] of [
      ['one/app', one],
      ['two/app', two],
    ] as const) {
      await expect(
        resolveCrossTeamRecipient(w.ports, {
          fromTeam: 'partner',
          toTeam: 'reviewers',
          senderProjectPath: w.project(id),
        })
      ).resolves.toMatchObject({ teamName: copy });
    }
  });
});
