import { describe, expect, it } from 'vitest';

import { SkillScaffoldService } from '@main/services/extensions/skills/SkillScaffoldService';
import { SkillRootsResolver } from '@main/services/extensions/skills/SkillRootsResolver';

describe('SkillScaffoldService', () => {
  it('normalizes valid relative draft file paths', () => {
    const service = new SkillScaffoldService();

    const files = service.normalizeDraftFiles([
      { relativePath: 'scripts/../scripts/run.sh', content: 'echo hi' },
    ]);

    expect(files[0]?.relativePath).toBe('scripts/run.sh');
  });

  it('rejects path traversal in draft file paths', () => {
    const service = new SkillScaffoldService();

    expect(() =>
      service.normalizeDraftFiles([{ relativePath: '../escape.txt', content: 'nope' }])
    ).toThrow('Invalid relative path');
  });

  it('rejects existing skill ids outside the selected root', async () => {
    const resolver = new SkillRootsResolver();
    const service = new SkillScaffoldService(resolver);

    await expect(
      service.resolveUpsertTarget(
        'project',
        'claude',
        '/tmp/demo-project',
        'valid-name',
        '/tmp/another-project/.claude/skills/foreign'
      )
    ).rejects.toThrow('outside the allowed root');
  });
});
