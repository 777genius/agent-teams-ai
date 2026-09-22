import { describe, expect, it } from 'vitest';

import { SkillRootsResolver } from '@main/services/extensions/skills/SkillRootsResolver';

describe('SkillRootsResolver', () => {
  it('returns user roots when no project path is provided', () => {
    const resolver = new SkillRootsResolver();

    const roots = resolver.resolve();

    expect(roots).toHaveLength(4);
    expect(roots.every((root) => root.scope === 'user')).toBe(true);
    expect(roots.map((root) => root.rootKind)).toEqual(['claude', 'cursor', 'agents', 'codex']);
  });

  it('returns project and user roots when project path is provided', () => {
    const resolver = new SkillRootsResolver();

    const roots = resolver.resolve('/tmp/demo-project');

    expect(roots).toHaveLength(8);
    expect(roots.filter((root) => root.scope === 'project')).toHaveLength(4);
    expect(roots.filter((root) => root.scope === 'user')).toHaveLength(4);
  });
});
