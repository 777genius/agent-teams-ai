import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { SkillPlanService } from '@main/services/extensions/skills/SkillPlanService';
import { SkillScaffoldService } from '@main/services/extensions/skills/SkillScaffoldService';
import { SkillsCatalogService } from '@main/services/extensions/skills/SkillsCatalogService';
import { SkillsMutationService } from '@main/services/extensions/skills/SkillsMutationService';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalSkillMutationExecutor } from '@main/services/extensions/skills/LocalSkillMutationExecutor';
import type { ResolvedSkillRoot } from '@main/services/extensions/skills/SkillRootsResolver';

function createExecutor() {
  return {
    preview: vi.fn<LocalSkillMutationExecutor['preview']>(async (plan) => plan.preview),
    apply: vi.fn<LocalSkillMutationExecutor['apply']>(async () => {}),
    deleteSkill: vi.fn<LocalSkillMutationExecutor['deleteSkill']>(async () => {}),
  };
}

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
    await Promise.all(
      createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  it('delegates a reviewed plan and leaves all effects to the engine executor', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-mutation-'));
    createdDirs.push(projectRoot);

    const skillsRoot = path.join(projectRoot, '.claude', 'skills');
    const skillDir = path.join(skillsRoot, 'demo');
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# old', 'utf8');
    await fs.writeFile(path.join(skillDir, 'scripts', 'README.md'), 'old script', 'utf8');

    const resolver = createResolver(skillsRoot);
    const executor = createExecutor();
    const mutationService = new SkillsMutationService(
      executor,
      resolver,
      new SkillsCatalogService(resolver),
      new SkillScaffoldService(resolver),
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

    expect(executor.apply).toHaveBeenCalledWith(preview.planId, {
      ...request,
      reviewPlanId: preview.planId,
    });
    await expect(fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).resolves.toBe('# old');
    await expect(fs.readFile(path.join(skillDir, 'scripts', 'README.md'), 'utf8')).resolves.toBe(
      'old script'
    );
  });

  it('preserves an engine stale-plan refusal without a filesystem fallback', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-mutation-'));
    createdDirs.push(projectRoot);

    const skillsRoot = path.join(projectRoot, '.claude', 'skills');
    const skillDir = path.join(skillsRoot, 'demo');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# old', 'utf8');

    const resolver = createResolver(skillsRoot);
    const executor = createExecutor();
    executor.apply.mockRejectedValue(new Error('The Skill files changed after review.'));
    const mutationService = new SkillsMutationService(
      executor,
      resolver,
      new SkillsCatalogService(resolver),
      new SkillScaffoldService(resolver),
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
    await expect(fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).resolves.toBe(
      '# changed after review'
    );
  });
});
