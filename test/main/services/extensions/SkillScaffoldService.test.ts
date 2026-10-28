import { describe, expect, it } from 'vitest';

import { SkillScaffoldService } from '@main/services/extensions/skills/SkillScaffoldService';
import { SkillRootsResolver } from '@main/services/extensions/skills/SkillRootsResolver';

describe('SkillScaffoldService', () => {
  it('normalizes valid relative draft file paths', () => {
    const service = new SkillScaffoldService();

    const files = service.normalizeDraftFiles([
      { relativePath: 'scripts/../scripts/run.sh', content: 'echo hi', createOnly: true },
    ]);

    expect(files[0]).toEqual({
      relativePath: 'scripts/run.sh',
      content: 'echo hi',
      createOnly: true,
    });
  });

  it.each([null, 'true', 1, {}])('rejects a non-boolean createOnly marker: %j', (createOnly) => {
    expect(() =>
      new SkillScaffoldService().normalizeDraftFiles([
        {
          relativePath: 'assets/README.md',
          content: '# Assets',
          createOnly: createOnly as boolean,
        },
      ])
    ).toThrow('createOnly must be a boolean');
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
