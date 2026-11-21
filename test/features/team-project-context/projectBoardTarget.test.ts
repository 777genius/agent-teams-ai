import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createProjectBoardPorts,
  ProjectBoardTargetError,
  resolveProjectBoardTarget,
  TeamMetadataUnreadableError,
  TeamProjectContextRegistry,
} from '../../../src/features/team-project-context/main';
import { TeamMetaStore } from '../../../src/main/services/team/TeamMetaStore';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * A per-project team `builders` with ready copies in projects A and B, a launch in progress in
 * project C and nothing in project D; an ordinary team `partner`. Read through the real metadata
 * store and registry.
 */
async function world() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'project-board-target-')));
  roots.push(root);
  const teamsBasePath = path.join(root, 'teams');
  const tasksBasePath = path.join(root, 'tasks');
  const project = (id: string) => path.join(root, 'projects', id);
  await Promise.all(
    [teamsBasePath, tasksBasePath, ...['a', 'b', 'c', 'd'].map(project)].map((dir) =>
      mkdir(dir, { recursive: true })
    )
  );
  const profileScope = 'project-board-profile';
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

  const copyOf = async (id: string, ready = true): Promise<string> => {
    const reserved = await registry.reserve('builders', project(id));
    if (!ready) return reserved.executionTeamName;
    await mkdir(path.join(teamsBasePath, reserved.executionTeamName), { recursive: true });
    await mkdir(path.join(tasksBasePath, reserved.executionTeamName), { recursive: true });
    await writeFile(
      path.join(teamsBasePath, reserved.executionTeamName, 'config.json'),
      JSON.stringify({ name: reserved.executionTeamName, projectPath: project(id) })
    );
    await claim(reserved.executionTeamName);
    await registry.confirmReady('builders', project(id), reserved.executionTeamName);
    return reserved.executionTeamName;
  };
  const copies = { a: await copyOf('a'), b: await copyOf('b'), c: await copyOf('c', false) };

  const store = new TeamMetaStore();
  const ports = createProjectBoardPorts(
    {
      getMeta: (name) => store.getMeta(name, teamsBasePath),
      metadataFileExists: (name) => store.metadataFileExists(name, teamsBasePath),
    },
    registry
  );
  const indexPath = path.join(teamsBasePath, 'builders', 'project-contexts.json');
  return { teamsBasePath, registry, ports, project, copies, indexPath, writeMeta };
}

async function refusal(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ProjectBoardTargetError)
      return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('Expected a refusal');
}

describe('resolveProjectBoardTarget', () => {
  it('gives each project its own copy and keeps ordinary teams and copies by their name', async () => {
    const w = await world();
    const index = await readFile(w.indexPath, 'utf8');
    const resolve = (teamName: string, projectPath?: string) =>
      resolveProjectBoardTarget(w.ports, { teamName, projectPath });

    await expect(resolve('builders', w.project('a'))).resolves.toEqual({
      teamName: w.copies.a,
      logicalTeamName: 'builders',
      projectPath: w.project('a'),
    });
    await expect(resolve('builders', w.project('b'))).resolves.toMatchObject({
      teamName: w.copies.b,
    });
    // A project is never applied to a team with one history, nor to a copy named exactly.
    await expect(resolve('partner', w.project('a'))).resolves.toEqual({ teamName: 'partner' });
    await expect(resolve(w.copies.b, w.project('a'))).resolves.toEqual({ teamName: w.copies.b });
    // Resolving only reads: no copy is reserved or created for a project.
    await refusal(resolve('builders', w.project('d')));
    expect(await readFile(w.indexPath, 'utf8')).toBe(index);
  });

  it('refuses instead of guessing a project', async () => {
    const w = await world();
    const required = await refusal(resolveProjectBoardTarget(w.ports, { teamName: 'builders' }));
    expect(required.code).toBe('PROJECT_REQUIRED');
    // The refusal names the projects that can be used: the ready ones, not the pending one.
    expect(required.message).toContain(w.project('a'));
    expect(required.message).toContain(w.project('b'));
    expect(required.message).not.toContain(w.project('c'));

    const resolve = (projectPath: string) =>
      refusal(resolveProjectBoardTarget(w.ports, { teamName: 'builders', projectPath }));
    expect((await resolve(w.project('d'))).code).toBe('NO_PROJECT_HISTORY');
    expect((await resolve(w.project('c'))).code).toBe('PROJECT_LAUNCH_PENDING');

    await w.registry.beginSoftDelete('builders');
    expect((await resolve(w.project('a'))).code).toBe('UNRESOLVED');
  });

  it('refuses a team whose metadata cannot be read', async () => {
    const w = await world();
    await w.writeMeta('builders', '{ not json');
    await expect(
      resolveProjectBoardTarget(w.ports, { teamName: 'builders', projectPath: w.project('a') })
    ).rejects.toBeInstanceOf(TeamMetadataUnreadableError);
  });
});
