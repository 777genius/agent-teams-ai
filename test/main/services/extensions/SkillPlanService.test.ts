import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillPlanService } from '@main/services/extensions/skills/SkillPlanService';
import { buildSkillDraftFiles } from '@renderer/components/extensions/skills/skillDraftUtils';

describe('SkillPlanService', () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
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

  it('preserves bundled files that the local editor cannot represent', async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-plan-preserve-'));
    createdDirs.push(targetDir);
    const existing = [
      ['SKILL.md', Buffer.from('# original')],
      ['assets/sample.bin', Buffer.from([0, 255, 128, 0, 22, 44])],
      ['references/guide.md', Buffer.from('Reviewed supporting documentation\n')],
      ['scripts/nested/task.sh', Buffer.from('#!/bin/sh\nexit 0\n')],
      ['assets/nested/README.md', Buffer.from('Nested asset description\n')],
    ] as const;
    for (const [relativePath, bytes] of existing) {
      await fs.mkdir(path.dirname(path.join(targetDir, relativePath)), { recursive: true });
      await fs.writeFile(path.join(targetDir, relativePath), bytes);
    }

    const plan = await new SkillPlanService().buildUpsertPlan(targetDir, [
      { relativePath: 'SKILL.md', content: '# edited metadata' },
      { relativePath: 'references/README.md', content: '# References\n' },
      { relativePath: 'assets/README.md', content: '# Assets\n' },
    ]);

    expect(plan.preview.summary.deleted).toBe(0);
    expect(plan.changes.map((change) => change.relativePath).sort()).toEqual([
      'SKILL.md',
      'assets/README.md',
      'references/README.md',
    ]);
    for (const [relativePath, bytes] of existing) {
      expect(await fs.readFile(path.join(targetDir, relativePath))).toEqual(bytes);
    }
  });

  it('does not treat an omitted binary file as an editable text placeholder', async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-plan-binary-draft-'));
    createdDirs.push(targetDir);
    await fs.mkdir(path.join(targetDir, 'assets'));
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), '# original');
    await fs.writeFile(path.join(targetDir, 'assets', 'README.md'), Buffer.from([0, 255, 128]));

    const plan = await new SkillPlanService().buildUpsertPlan(targetDir, [
      { relativePath: 'SKILL.md', content: '# edited' },
    ]);

    expect(plan.changes.map((change) => change.relativePath)).toEqual(['SKILL.md']);
    expect(plan.preview.summary.deleted).toBe(0);
  });

  it.each([
    ['custom text', Buffer.from('Keep this authored asset guide\n')],
    ['binary', Buffer.from([0, 255, 128, 0, 22, 44])],
  ])('preserves an existing %s README when the editor adds starter files', async (_kind, bytes) => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-plan-scaffold-'));
    createdDirs.push(targetDir);
    await fs.mkdir(path.join(targetDir, 'assets'));
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), '# original');
    await fs.writeFile(path.join(targetDir, 'assets', 'README.md'), bytes);

    const draft = buildSkillDraftFiles({
      rawContent: '# edited metadata',
      includeAssets: true,
      includeReferences: true,
      includeScripts: true,
    });
    const plan = await new SkillPlanService().buildUpsertPlan(targetDir, draft);

    expect(plan.changes.some((change) => change.relativePath === 'assets/README.md')).toBe(false);
    expect(plan.preview.summary).toEqual({ created: 2, updated: 1, deleted: 0, binary: 0 });
    expect(
      plan.changes
        .filter((change) => change.action === 'create')
        .map((change) => change.relativePath)
    ).toEqual(['references/README.md', 'scripts/README.md']);
    expect(await fs.readFile(path.join(targetDir, 'assets', 'README.md'))).toEqual(bytes);
  });

  it('describes a reviewed import binary deletion without decoding or claiming to copy it', async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-plan-binary-removal-'));
    createdDirs.push(targetDir);
    const binary = Buffer.from([0, 255, 128, 0, 22, 44]);
    await fs.mkdir(path.join(targetDir, 'assets'));
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), '# original');
    await fs.writeFile(path.join(targetDir, 'assets', 'sample.bin'), binary);

    const plan = await new SkillPlanService().buildImportPlan(targetDir, [
      {
        relativePath: 'SKILL.md',
        absolutePath: path.join(targetDir, 'SKILL.md'),
        content: '# imported',
        isBinary: false,
      },
    ]);

    expect(plan.changes.find((change) => change.relativePath === 'assets/sample.bin')).toEqual({
      relativePath: 'assets/sample.bin',
      absolutePath: path.join(targetDir, 'assets', 'sample.bin'),
      action: 'delete',
      expectedSHA256: createHash('sha256').update(binary).digest('hex'),
      oldContent: null,
      newContent: null,
      isBinary: true,
    });
    expect(plan.preview.summary).toEqual({ created: 0, updated: 1, deleted: 1, binary: 1 });
    expect(plan.preview.warnings.join('\n')).not.toContain('copied as-is');
  });

  it('still reviews an explicit replacement of an existing optional text file', async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-plan-explicit-edit-'));
    createdDirs.push(targetDir);
    await fs.mkdir(path.join(targetDir, 'assets'));
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), '# original');
    await fs.writeFile(path.join(targetDir, 'assets', 'README.md'), 'previous guide');

    const plan = await new SkillPlanService().buildUpsertPlan(targetDir, [
      { relativePath: 'SKILL.md', content: '# edited' },
      { relativePath: 'assets/README.md', content: 'explicitly reviewed guide' },
    ]);

    expect(plan.changes.find((change) => change.relativePath === 'assets/README.md')).toMatchObject(
      {
        action: 'update',
        oldContent: 'previous guide',
        newContent: 'explicitly reviewed guide',
      }
    );
  });
});
