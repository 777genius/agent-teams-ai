import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureAuthoringRoots } from '../../../src/features/extension-management/main/infrastructure/captureAuthoringRoots';
import { prepareSkillCopy } from '../../../src/features/extension-management/main/infrastructure/prepareSkillCopy';
import { resolveSkillCopySources } from '../../../src/features/extension-management/main/infrastructure/resolveSkillCopySources';

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'uap-authoring-capture-')));
  paths.push(root);
  const profiles = [{ client: 'claude', configRoot: path.join(root, 'native') }];
  const projects = [{ id: 'registered', path: path.join(root, 'project') }];
  await mkdir(projects[0].path);
  return { root, profiles, projects };
}
describe('trusted local Skill roots', () => {
  it('prepares only the chosen inventoried Skill and preserves binary copy bytes', async () => {
    const f = await fixture();
    const source = path.join(f.root, 'managed-source');
    await mkdir(path.join(source, 'assets'), { recursive: true });
    await writeFile(
      path.join(source, 'SKILL.md'),
      '---\nname: managed-source\ndescription: Inert fixture\n---\nInstructions.\n'
    );
    const binary = Buffer.from([0, 255, 1, 127]);
    await writeFile(path.join(source, 'assets', 'fixture.bin'), binary);
    const captured = await captureAuthoringRoots(
      f.profiles,
      { client: 'claude', scope: 'user' },
      async () => f.projects
    );
    const candidate = (await resolveSkillCopySources([source], captured.authoringRoots))[0];
    const result = await prepareSkillCopy([source], captured.authoringRoots, {
      candidateId: candidate.id,
      rootKind: 'agents',
      folderName: 'managed-source-copy',
    });
    expect(result.change.action).toBe('upsert');
    expect(result.change.files).toContainEqual({
      relativePath: 'assets/fixture.bin',
      expectedSHA256: null,
      contentBase64: binary.toString('base64'),
    });
    expect(result.preview.summary.created).toBe(2);
    await expect(
      prepareSkillCopy([source], captured.authoringRoots, {
        candidateId: 'not-in-inventory',
        rootKind: 'agents',
        folderName: 'copy',
      })
    ).rejects.toThrow('source changed');
    await expect(
      prepareSkillCopy([source], captured.authoringRoots, {
        candidateId: candidate.id,
        rootKind: 'agents',
        folderName: '../escape',
      })
    ).rejects.toThrow('valid destination');
  });
  it('offers exact Skills from an inventoried package and skips symlink escapes', async () => {
    const f = await fixture();
    const bundle = path.join(f.root, 'managed-bundle');
    for (const name of ['alpha', 'beta']) {
      await mkdir(path.join(bundle, 'skills', name), { recursive: true });
      await writeFile(path.join(bundle, 'skills', name, 'SKILL.md'), '# Inert copy fixture');
    }
    const outside = path.join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'SKILL.md'), '# Not inventoried');
    await symlink(outside, path.join(bundle, 'escape'));
    const candidates = await resolveSkillCopySources([bundle], []);
    expect(candidates.map((item) => item.skillName)).toEqual(['alpha', 'beta']);
    expect(candidates.every((item) => item.sourceDir.startsWith(`${bundle}${path.sep}`))).toBe(
      true
    );
  });
  it('refuses an arbitrary project path and resolves a known project selector', async () => {
    const f = await fixture();
    await expect(
      captureAuthoringRoots(
        f.profiles,
        { client: 'claude', scope: 'user', authoringProject: path.join(f.root, 'unknown') },
        async () => f.projects
      )
    ).rejects.toThrow('Open this project');
    const capture = await captureAuthoringRoots(
      f.profiles,
      { client: 'claude', scope: 'user', authoringProject: 'registered' },
      async () => f.projects
    );
    const skill = await capture.locateLocalSkill(
      path.join(f.projects[0].path, '.agents', 'skills', 'draft')
    );
    expect(skill.skillName).toBe('draft');
    const reopened = await captureAuthoringRoots(
      f.profiles,
      { client: 'codex', scope: 'user', authoringRootId: skill.rootId },
      async () => f.projects
    );
    expect(reopened.authoringRoots).toContainEqual(
      expect.objectContaining({ id: skill.rootId, scope: 'project' })
    );
  });
  it('canonicalizes aliases before comparing managed ownership and refuses escaped targets', async () => {
    const f = await fixture();
    const root = path.join(f.profiles[0].configRoot, 'skills');
    const managed = path.join(root, 'managed');
    await mkdir(managed, { recursive: true });
    await symlink(managed, path.join(root, 'alias'));
    const capture = await captureAuthoringRoots(
      f.profiles,
      { client: 'claude', scope: 'user' },
      async () => f.projects
    );
    const skill = await capture.locateLocalSkill(path.join(root, 'alias'));
    expect(skill.skillName).toBe('managed');
    expect(await skill.overlapsManagedPath(path.join(managed, 'SKILL.md'))).toBe(true);
    expect(await skill.overlapsManagedPath(path.join(root, 'another', 'SKILL.md'))).toBe(false);
    await symlink(f.root, path.join(root, 'escape'));
    await expect(capture.locateLocalSkill(path.join(root, 'escape'))).rejects.toThrow('outside');
  });
});
