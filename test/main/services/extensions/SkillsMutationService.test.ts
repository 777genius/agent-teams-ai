import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillPlanService } from '@main/services/extensions/skills/SkillPlanService';
import { SkillScaffoldService } from '@main/services/extensions/skills/SkillScaffoldService';
import { SkillsCatalogService } from '@main/services/extensions/skills/SkillsCatalogService';
import { SkillsMutationService } from '@main/services/extensions/skills/SkillsMutationService';

import type { ResolvedSkillRoot } from '@main/services/extensions/skills/SkillRootsResolver';

function createResolver(rootPath: string) {
  return {
    resolve(projectPath?: string): ResolvedSkillRoot[] {
      return [
        {
          scope: 'project',
          rootKind: 'claude',
          projectRoot: projectPath ?? rootPath,
          rootPath,
        },
      ];
    },
  };
}

describe('SkillsMutationService', () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('applies the reviewed plan and deletes obsolete managed files', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-mutation-'));
    createdDirs.push(projectRoot);

    const skillsRoot = path.join(projectRoot, '.claude', 'skills');
    const skillDir = path.join(skillsRoot, 'demo');
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# old', 'utf8');
    await fs.writeFile(path.join(skillDir, 'scripts', 'README.md'), 'old script', 'utf8');

    const resolver = createResolver(skillsRoot);
    const mutationService = new SkillsMutationService(
      resolver as any,
      new SkillsCatalogService(resolver as any),
      new SkillScaffoldService(resolver as any),
      undefined,
      new SkillPlanService()
    );

    const request = {
      scope: 'project' as const,
      rootKind: 'claude' as const,
      projectPath: projectRoot,
      folderName: 'demo',
      existingSkillId: skillDir,
      files: [{ relativePath: 'SKILL.md', content: '# updated' }],
    };

    const preview = await mutationService.previewUpsert(request);
    await mutationService.applyUpsert({ ...request, reviewPlanId: preview.planId });

    await expect(fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).resolves.toBe('# updated');
    await expect(fs.stat(path.join(skillDir, 'scripts', 'README.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects apply when the reviewed plan is stale', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-mutation-'));
    createdDirs.push(projectRoot);

    const skillsRoot = path.join(projectRoot, '.claude', 'skills');
    const skillDir = path.join(skillsRoot, 'demo');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# old', 'utf8');

    const resolver = createResolver(skillsRoot);
    const mutationService = new SkillsMutationService(
      resolver as any,
      new SkillsCatalogService(resolver as any),
      new SkillScaffoldService(resolver as any),
      undefined,
      new SkillPlanService()
    );

    const request = {
      scope: 'project' as const,
      rootKind: 'claude' as const,
      projectPath: projectRoot,
      folderName: 'demo',
      existingSkillId: skillDir,
      files: [{ relativePath: 'SKILL.md', content: '# updated' }],
    };

    const preview = await mutationService.previewUpsert(request);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# changed after review', 'utf8');

    await expect(
      mutationService.applyUpsert({ ...request, reviewPlanId: preview.planId })
    ).rejects.toThrow('changed after review');
  });
});
