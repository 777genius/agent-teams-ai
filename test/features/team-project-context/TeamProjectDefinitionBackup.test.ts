import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  backupProjectTeamDefinition,
  recoverMissingProjectTeamDefinition,
  recoverMissingProjectTeamDefinitions,
} from '../../../src/features/team-project-context/main/TeamProjectDefinitionBackup';
import {
  getBackupsBasePath, getTasksBasePath, getTeamsBasePath,
  setAppDataBasePath, setClaudeBasePathOverride,
} from '../../../src/main/utils/pathDecoder';
import {
  claimTeamForThisProfile, readTeamOwnerProfileScope, resolveThisAppProfileScope,
} from '../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';

const roots: string[] = [];
async function fixture(hasContext = true, name = 'builders') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'logical-team-definition-backup-'));
  roots.push(root);
  setClaudeBasePathOverride(path.join(root, 'claude'));
  setAppDataBasePath(path.join(root, 'app'));
  const logical = path.join(getTeamsBasePath(), name);
  const tasks = path.join(getTasksBasePath(), name);
  const alias = 'ptc-project-a';
  const aliasDir = path.join(getTeamsBasePath(), alias);
  await Promise.all([
    fs.mkdir(logical, { recursive: true }),
    fs.mkdir(tasks, { recursive: true }),
    fs.mkdir(getBackupsBasePath(), { recursive: true }),
  ]);
  await fs.writeFile(path.join(logical, 'team.meta.json'), JSON.stringify({
    version: 1, cwd: root, createdAt: 123, projectContextMode: 'per_project',
  }));
  await fs.writeFile(path.join(logical, 'members.meta.json'), JSON.stringify({
    version: 1, members: [{ name: 'alice', role: 'Engineer' }],
  }));
  await claimTeamForThisProfile({
    teamsBasePath: getTeamsBasePath(), teamName: name, reason: 'create',
  });
  if (hasContext) {
    await fs.mkdir(aliasDir, { recursive: true });
    await fs.writeFile(path.join(aliasDir, 'config.json'), JSON.stringify({
      name: alias, projectPath: root, members: [],
    }));
    await claimTeamForThisProfile({
      teamsBasePath: getTeamsBasePath(), teamName: alias, reason: 'create',
    });
    await fs.writeFile(path.join(logical, 'project-contexts.json'), JSON.stringify({
      version: 1, logicalTeamName: name,
      contexts: [{
        id: '11111111-1111-4111-8111-111111111111',
        projectKey: root, projectPath: root,
        executionTeamName: alias, state: 'ready',
      }],
    }));
  }
  const backup = path.join(getBackupsBasePath(), 'project-team-definitions', name + '.json');
  return { name, root, logical, tasks, alias, aliasDir, backup };
}

afterEach(async () => {
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {
    recursive: true, force: true,
  })));
});

describe('logical per-project team definition backup', () => {
  it('captures a metadata-only team without forging native config.json', async () => {
    const f = await fixture();
    expect(await backupProjectTeamDefinition(f.name)).toBe(true);
    const snapshot = JSON.parse(await fs.readFile(f.backup, 'utf8')) as {
      files: Record<string, { content: string }>;
    };
    expect(Object.keys(snapshot.files)).toContain('project-contexts.json');
    await expect(fs.stat(path.join(f.logical, 'config.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers the exact manifest only when the original owned alias still exists', async () => {
    const f = await fixture();
    await backupProjectTeamDefinition(f.name);
    const original = await fs.readFile(path.join(f.logical, 'project-contexts.json'), 'utf8');
    await fs.rm(f.logical, { recursive: true });
    await fs.rm(f.tasks, { recursive: true });
    expect(await recoverMissingProjectTeamDefinitions()).toBe(1);
    expect(await fs.readFile(path.join(f.logical, 'project-contexts.json'), 'utf8')).toBe(original);
    expect(await readTeamOwnerProfileScope(f.logical)).toBe(resolveThisAppProfileScope());
    expect(await recoverMissingProjectTeamDefinition(f.name)).toBe(false);
  });

  it('backs up and restores a historical logical team name longer than 64 characters', async () => {
    const name = 'legacy-' + 'a'.repeat(85);
    const f = await fixture(true, name);
    expect(await backupProjectTeamDefinition(name)).toBe(true);
    await fs.rm(f.logical, { recursive: true });
    await fs.rm(f.tasks, { recursive: true });
    expect(await recoverMissingProjectTeamDefinition(name)).toBe(true);
    expect(await readTeamOwnerProfileScope(f.logical)).toBe(resolveThisAppProfileScope());
    expect(await fs.readFile(path.join(f.logical, 'project-contexts.json'), 'utf8'))
      .toContain(f.alias);
  });

  it('allows exactly one recovery publisher when two processes race for the name', async () => {
    const f = await fixture();
    await backupProjectTeamDefinition(f.name);
    await fs.rm(f.logical, { recursive: true });
    await fs.rm(f.tasks, { recursive: true });
    const settled = await Promise.all([
      recoverMissingProjectTeamDefinition(f.name),
      recoverMissingProjectTeamDefinition(f.name),
    ]);
    expect(settled.sort()).toEqual([false, true]);
    expect(await readTeamOwnerProfileScope(f.logical)).toBe(resolveThisAppProfileScope());
    expect(await fs.stat(f.tasks)).toBeTruthy();
  });

  it('does not resurrect a deleted empty team from a retained backup', async () => {
    const f = await fixture(false);
    await backupProjectTeamDefinition(f.name);
    await fs.rm(f.logical, { recursive: true });
    await fs.rm(f.tasks, { recursive: true });
    expect(await recoverMissingProjectTeamDefinition(f.name)).toBe(false);
  });

  it('does not trust a stale backup when the native alias no longer belongs to this profile', async () => {
    const f = await fixture();
    await backupProjectTeamDefinition(f.name);
    await fs.rm(path.join(f.aliasDir, '.agent-teams-owner.json'));
    await fs.rm(f.logical, { recursive: true });
    await fs.rm(f.tasks, { recursive: true });
    expect(await recoverMissingProjectTeamDefinition(f.name)).toBe(false);
  });

  it('refuses corrupt backup content without creating a logical team directory', async () => {
    const f = await fixture();
    await backupProjectTeamDefinition(f.name);
    const snapshot = JSON.parse(await fs.readFile(f.backup, 'utf8')) as {
      files: Record<string, { content: string }>;
    };
    snapshot.files['project-contexts.json']!.content = '{"tampered":true}';
    await fs.writeFile(f.backup, JSON.stringify(snapshot));
    await fs.rm(f.logical, { recursive: true });
    await fs.rm(f.tasks, { recursive: true });
    await expect(recoverMissingProjectTeamDefinition(f.name)).rejects.toThrow('integrity');
    await expect(fs.stat(f.logical)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
