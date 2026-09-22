import { describe, expect, it } from 'vitest';

import { resolveSkillProjectPath } from '../../../../../src/renderer/components/extensions/skills/skillProjectUtils';

describe('resolveSkillProjectPath', () => {
  it('returns undefined for user-scoped skills', () => {
    expect(resolveSkillProjectPath('user', '/tmp/project-a', '/tmp/project-a')).toBeUndefined();
  });

  it('prefers the skill project root over the current tab project for project-scoped skills', () => {
    expect(resolveSkillProjectPath('project', '/tmp/project-b', '/tmp/project-a')).toBe(
      '/tmp/project-a'
    );
  });

  it('falls back to the current tab project when a project skill has no embedded root', () => {
    expect(resolveSkillProjectPath('project', '/tmp/project-a', null)).toBe('/tmp/project-a');
  });
});
