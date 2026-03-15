import { describe, expect, it } from 'vitest';

import {
  buildSkillTemplate,
  readSkillTemplateInput,
} from '../../../../../src/renderer/components/extensions/skills/skillDraftUtils';

describe('skillDraftUtils', () => {
  it('builds and parses structured sections for guided editing', () => {
    const template = buildSkillTemplate({
      name: 'Review Helper',
      description: 'Helps with code review',
      license: 'MIT',
      compatibility: 'claude-code',
      invocationMode: 'manual-only',
      whenToUse: 'Use this when a PR needs review.',
      steps: '1. Read the diff.\n2. Call out the biggest risk first.',
      notes: '- Prefer concrete findings over summaries.',
    });

    const parsed = readSkillTemplateInput(template);

    expect(parsed).toMatchObject({
      name: 'Review Helper',
      description: 'Helps with code review',
      license: 'MIT',
      compatibility: 'claude-code',
      invocationMode: 'manual-only',
      whenToUse: 'Use this when a PR needs review.',
      steps: '1. Read the diff.\n2. Call out the biggest risk first.',
      notes: '- Prefer concrete findings over summaries.',
    });
  });
});
