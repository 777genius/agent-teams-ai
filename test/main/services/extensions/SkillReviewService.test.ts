import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillReviewService } from '@main/services/extensions/skills/SkillReviewService';

describe('SkillReviewService', () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('builds create/update review preview correctly', async () => {
    const service = new SkillReviewService();
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-review-'));
    createdDirs.push(targetDir);

    await fs.mkdir(path.join(targetDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), '# old', 'utf8');

    const changes = await service.buildTextChanges(targetDir, [
      { relativePath: 'SKILL.md', content: '# new' },
      { relativePath: 'scripts/run.sh', content: 'echo hi' },
    ]);

    expect(changes.find((change) => change.relativePath === 'SKILL.md')?.action).toBe('update');
    expect(changes.find((change) => change.relativePath === 'scripts/run.sh')?.action).toBe('create');
  });
});
