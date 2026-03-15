import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillImportService } from '@main/services/extensions/skills/SkillImportService';

describe('SkillImportService', () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('skips hidden entries and reports the warning', async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-import-'));
    createdDirs.push(sourceDir);

    await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Demo', 'utf8');
    await fs.writeFile(path.join(sourceDir, '.DS_Store'), 'hidden', 'utf8');
    await fs.mkdir(path.join(sourceDir, '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, '.cache', 'ignore.txt'), 'hidden', 'utf8');

    const inspection = await new SkillImportService().inspectSourceDir(sourceDir);

    expect(inspection.files.map((file) => file.relativePath)).toEqual(['SKILL.md']);
    expect(inspection.hiddenEntriesSkipped).toBe(2);
    expect(inspection.warnings).toContain('Hidden files and folders were skipped during import.');
  });

  it('rejects symbolic links in the import source', async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-import-'));
    createdDirs.push(sourceDir);

    await fs.writeFile(path.join(sourceDir, 'SKILL.md'), '# Demo', 'utf8');
    await fs.writeFile(path.join(sourceDir, 'real.txt'), 'hello', 'utf8');
    await fs.symlink(path.join(sourceDir, 'real.txt'), path.join(sourceDir, 'linked.txt'));

    await expect(new SkillImportService().inspectSourceDir(sourceDir)).rejects.toThrow(
      'symbolic links'
    );
  });
});
