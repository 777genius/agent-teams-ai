import { describe, expect, it } from 'vitest';

import {
  getSuggestedSkillFolderNameFromPath,
  toSuggestedSkillFolderName,
} from '../../../../../src/renderer/components/extensions/skills/skillFolderNameUtils';

describe('skillFolderNameUtils', () => {
  it('creates a safe slug from a human-readable skill name', () => {
    expect(toSuggestedSkillFolderName('Review Helper 2')).toBe('review-helper-2');
  });

  it('falls back to a safe default when the name cannot be slugged', () => {
    expect(toSuggestedSkillFolderName('Привет мир')).toBe('new-skill');
  });

  it('sanitizes imported folder names from the selected source path', () => {
    expect(getSuggestedSkillFolderNameFromPath('/tmp/My Skill Folder')).toBe(
      'my-skill-folder'
    );
  });

  it('uses an import-specific fallback when the source folder name is unusable', () => {
    expect(getSuggestedSkillFolderNameFromPath('/tmp/技能')).toBe('imported-skill');
  });
});
