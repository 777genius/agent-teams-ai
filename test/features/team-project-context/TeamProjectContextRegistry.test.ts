import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TeamProjectContextRegistry,
  TeamProjectContextUnavailableError,
} from '../../../src/features/team-project-context/main';
import { claimTeamForThisProfile } from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-project-context-test-'));
  roots.push(root);
  const teamsBasePath = path.join(root, 'teams');
  const tasksBasePath = path.join(root, 'tasks');
  const workspaceA = path.join(root, 'a');
  const workspaceB = path.join(root, 'b');
  await Promise.all([
    mkdir(path.join(teamsBasePath, 'logical-team'), { recursive: true }),
    mkdir(tasksBasePath, { recursive: true }),
    mkdir(workspaceA),
    mkdir(workspaceB),
  ]);
  await claimTeamForThisProfile({
    teamsBasePath, teamName: 'logical-team', reason: 'create', profileScope: 'test-profile',
  });
  const registry = new TeamProjectContextRegistry({
    teamsBasePath, tasksBasePath, profileScope: 'test-profile',
  });
  return { registry, root, teamsBasePath, tasksBasePath, workspaceA, workspaceB };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('TeamProjectContextRegistry', () => {
  it('is read-only until a context is explicitly created', async () => {
    const f = await fixture();
    expect(await f.registry.find('logical-team', f.workspaceA)).toBeNull();
    await expect(readFile(path.join(f.teamsBasePath, 'logical-team', 'project-contexts.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('assigns separate native team namespaces to A and B, and restores A', async () => {
    const f = await fixture();
    const a = await f.registry.getOrCreate('logical-team', f.workspaceA);
    const b = await f.registry.getOrCreate('logical-team', f.workspaceB);
    expect(a.executionTeamName).not.toBe(b.executionTeamName);
    expect(a.state).toBe('ready');
    expect(await f.registry.find('logical-team', f.workspaceA)).toEqual(a);
    expect(await f.registry.getOrCreate('logical-team', f.workspaceA)).toEqual(a);
    await writeFile(path.join(f.tasksBasePath, a.executionTeamName, '1.json'), '{"id":"1"}');
    await expect(readFile(path.join(f.tasksBasePath, b.executionTeamName, '1.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('coalesces concurrent creation into one durable context', async () => {
    const f = await fixture();
    const rows = await Promise.all(
      Array.from({ length: 5 }, () => f.registry.getOrCreate('logical-team', f.workspaceA))
    );
    expect(new Set(rows.map((row) => row.executionTeamName)).size).toBe(1);
  });

  it('fails closed for a foreign-owned logical team', async () => {
    const f = await fixture();
    const foreign = new TeamProjectContextRegistry({
      teamsBasePath: f.teamsBasePath, tasksBasePath: f.tasksBasePath, profileScope: 'foreign',
    });
    await expect(foreign.getOrCreate('logical-team', f.workspaceA))
      .rejects.toBeInstanceOf(TeamProjectContextUnavailableError);
  });

  it('rejects a corrupt index instead of silently reverting to shared storage', async () => {
    const f = await fixture();
    await writeFile(path.join(f.teamsBasePath, 'logical-team', 'project-contexts.json'), '{broken');
    await expect(f.registry.find('logical-team', f.workspaceA))
      .rejects.toBeInstanceOf(TeamProjectContextUnavailableError);
  });
});
