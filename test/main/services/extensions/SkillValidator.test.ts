import { describe, expect, it } from 'vitest';

import { SkillValidator } from '@main/services/extensions/skills/SkillValidator';

import type { SkillCatalogItem } from '@shared/types/extensions';

function makeSkill(overrides: Partial<SkillCatalogItem>): SkillCatalogItem {
  return {
    id: '/tmp/skill',
    sourceType: 'filesystem',
    name: 'demo',
    description: 'demo',
    folderName: 'demo',
    scope: 'user',
    rootKind: 'claude',
    projectRoot: null,
    discoveryRoot: '/tmp/.claude/skills',
    skillDir: '/tmp/.claude/skills/demo',
    skillFile: '/tmp/.claude/skills/demo/SKILL.md',
    metadata: {},
    invocationMode: 'auto',
    flags: { hasScripts: false, hasReferences: false, hasAssets: false },
    isValid: true,
    issues: [],
    modifiedAt: 1,
    ...overrides,
  };
}

describe('SkillValidator', () => {
  it('adds duplicate-name warnings across roots', () => {
    const validator = new SkillValidator();

    const result = validator.annotateCatalog([
      makeSkill({ id: '/a', scope: 'project', rootKind: 'claude' }),
      makeSkill({ id: '/b', scope: 'user', rootKind: 'cursor' }),
    ]);

    expect(result[0].issues.map((issue) => issue.code)).toContain('duplicate-name');
    expect(result[1].issues.map((issue) => issue.code)).toContain('duplicate-name');
  });

  it('does not warn when shared and codex-only overlays reuse the same skill name', () => {
    const validator = new SkillValidator();

    const result = validator.annotateCatalog([
      makeSkill({ id: '/a', scope: 'project', rootKind: 'claude' }),
      makeSkill({ id: '/b', scope: 'project', rootKind: 'codex' }),
    ]);

    expect(result[0].issues.map((issue) => issue.code)).not.toContain('duplicate-name');
    expect(result[1].issues.map((issue) => issue.code)).not.toContain('duplicate-name');
  });

  it('sorts by validity, scope, root precedence, then name', () => {
    const validator = new SkillValidator();

    const result = validator.annotateCatalog([
      makeSkill({ id: '/3', name: 'z-user', scope: 'user', rootKind: 'claude' }),
      makeSkill({ id: '/2', name: 'b-project-cursor', scope: 'project', rootKind: 'cursor' }),
      makeSkill({ id: '/1', name: 'a-project-claude', scope: 'project', rootKind: 'claude' }),
      makeSkill({ id: '/5', name: 'c-project-codex', scope: 'project', rootKind: 'codex' }),
      makeSkill({
        id: '/4',
        name: 'invalid',
        isValid: false,
        issues: [{ code: 'missing-name', message: 'missing', severity: 'error' }],
      }),
    ]);

    expect(result.map((item) => item.id)).toEqual(['/1', '/2', '/5', '/3', '/4']);
  });
});
