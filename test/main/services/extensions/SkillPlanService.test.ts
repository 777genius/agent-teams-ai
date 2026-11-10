import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillPlanService } from '@main/services/extensions/skills/SkillPlanService';

describe('SkillPlanService', () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('builds a canonical upsert plan including managed deletions', async () => {
    const service = new SkillPlanService();
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-plan-'));
    createdDirs.push(targetDir);

    await fs.mkdir(path.join(targetDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), '# old', 'utf8');
    await fs.writeFile(path.join(targetDir, 'scripts', 'README.md'), 'old script', 'utf8');
    await fs.writeFile(path.join(targetDir, 'notes.txt'), 'keep me', 'utf8');

    const plan = await service.buildUpsertPlan(targetDir, [
      { relativePath: 'SKILL.md', content: '# new' },
      { relativePath: 'references/README.md', content: '# refs' },
    ]);

    expect(plan.preview.summary).toEqual({
      created: 1,
      updated: 1,
      deleted: 1,
      binary: 0,
    });
    expect(
      Object.fromEntries(plan.preview.changes.map((change) => [change.relativePath, change.action]))
    ).toEqual({
      'SKILL.md': 'update',
      'references/README.md': 'create',
      'scripts/README.md': 'delete',
    });
    expect(plan.preview.warnings).toContain(
      '1 managed file will be removed to match this reviewed plan.'
    );
    expect(plan.preview.warnings).toContain(
      'Existing files outside the managed skill set will be kept as-is.'
    );
  });
});
