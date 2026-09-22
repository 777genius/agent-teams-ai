import { describe, expect, it } from 'vitest';

import { SkillMetadataParser } from '@main/services/extensions/skills/SkillMetadataParser';

describe('SkillMetadataParser', () => {
  const parser = new SkillMetadataParser();
  const root = {
    scope: 'project' as const,
    rootKind: 'claude' as const,
    projectRoot: '/tmp/project',
    rootPath: '/tmp/project/.claude/skills',
  };

  it('parses valid frontmatter and derives warnings', () => {
    const item = parser.parseCatalogItem({
      skillDir: '/tmp/project/.claude/skills/demo-skill',
      folderName: 'demo-skill',
      skillFile: '/tmp/project/.claude/skills/demo-skill/Skill.md',
      rawContent: `---
name: demo-skill
description: Test skill
version: 1.2.3
allowed-tools:
  - Read
compatibility: Requires network and API key
unknown-key: true
---

# Demo`,
      modifiedAt: 1,
      flags: { hasScripts: true, hasReferences: false, hasAssets: false },
      root,
    });

    expect(item.isValid).toBe(true);
    expect(item.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'nonstandard-file-name',
        'unknown-frontmatter-keys',
        'has-scripts',
        'allowed-tools-advisory',
        'compatibility-advisory',
      ])
    );
    expect(item.issues).not.toContainEqual(
      expect.objectContaining({
        code: 'unknown-frontmatter-keys',
        message: expect.stringContaining('version'),
      })
    );
    expect(item.issues).toContainEqual(
      expect.objectContaining({
        code: 'has-scripts',
        severity: 'info',
      })
    );
  });

  it('marks missing frontmatter as invalid', () => {
    const item = parser.parseCatalogItem({
      skillDir: '/tmp/project/.claude/skills/demo-skill',
      folderName: 'demo-skill',
      skillFile: '/tmp/project/.claude/skills/demo-skill/SKILL.md',
      rawContent: '# No frontmatter',
      modifiedAt: 1,
      flags: { hasScripts: false, hasReferences: false, hasAssets: false },
      root,
    });

    expect(item.isValid).toBe(false);
    expect(item.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['missing-frontmatter', 'missing-name', 'missing-description'])
    );
  });
});
