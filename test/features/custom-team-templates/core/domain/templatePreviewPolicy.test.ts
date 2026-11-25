import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import { serializeCanonicalTemplateContent } from '@features/custom-team-templates/core/domain/canonicalTemplateSerialization';
import { TEMPLATE_DESCRIPTION_MAX_LENGTH } from '@features/custom-team-templates/core/domain/templateLimits';
import {
  buildTemplatePreviewContent,
  validateTemplateDescription,
} from '@features/custom-team-templates/core/domain/templatePreviewPolicy';
import { describe, expect, it } from 'vitest';

const snapshot = {
  sourceTeamName: 'demo-team',
  teamPrompt: 'Coordinate the team.',
  roster: {
    status: 'readable',
    members: [
      { name: 'engineer', role: 'Engineer', workflow: 'Build.' },
      { name: 'qa', role: 'QA', workflow: 'Verify.' },
    ],
  },
} as const;

describe('buildTemplatePreviewContent', () => {
  it('produces canonical content identical to the projected configuration', () => {
    const result = buildTemplatePreviewContent({
      snapshot,
      name: '  Demo   Template  ',
      description: '  Reusable demo roster.  ',
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.preview.name).toBe('Demo   Template');
    expect(result.preview.description).toBe('Reusable demo roster.');
    expect(result.preview.canonicalContent).toBe(
      serializeCanonicalTemplateContent({
        schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
        teamPrompt: snapshot.teamPrompt,
        members: [
          { name: 'engineer', role: 'Engineer', workflow: 'Build.' },
          { name: 'qa', role: 'QA', workflow: 'Verify.' },
        ],
      })
    );
    expect(result.preview.warnings).toEqual([]);
  });

  it('omits an empty description', () => {
    const result = buildTemplatePreviewContent({ snapshot, name: 'Demo', description: '   ' });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.preview.description).toBeUndefined();
    expect(Object.keys(result.preview)).not.toContain('description');
  });

  it('rejects an invalid name without truncating it', () => {
    const result = buildTemplatePreviewContent({ snapshot, name: '   ' });
    expect(result).toEqual({
      status: 'validationFailed',
      issues: [{ code: 'templateNameRequired', field: 'name' }],
    });
  });

  it('rejects an oversized description', () => {
    const result = buildTemplatePreviewContent({
      snapshot,
      name: 'Demo',
      description: 'd'.repeat(TEMPLATE_DESCRIPTION_MAX_LENGTH + 1),
    });
    expect(result).toEqual({
      status: 'validationFailed',
      issues: [{ code: 'templateDescriptionTooLong', field: 'description' }],
    });
  });

  it('blocks preview when roster metadata is unreadable', () => {
    const result = buildTemplatePreviewContent({
      snapshot: { ...snapshot, roster: { status: 'unreadable' } },
      name: 'Demo',
    });
    expect(result).toEqual({ status: 'rosterUnreadable', sourceTeamName: 'demo-team' });
  });

  it('reports local validation issues before an unreadable roster', () => {
    const result = buildTemplatePreviewContent({
      snapshot: { ...snapshot, roster: { status: 'unreadable' } },
      name: '',
    });
    expect(result).toEqual({
      status: 'validationFailed',
      issues: [{ code: 'templateNameRequired', field: 'name' }],
    });
  });
});

describe('validateTemplateDescription', () => {
  it('accepts undefined and bounded descriptions', () => {
    expect(validateTemplateDescription(undefined)).toEqual([]);
    expect(validateTemplateDescription('Notes')).toEqual([]);
    expect(validateTemplateDescription('d'.repeat(TEMPLATE_DESCRIPTION_MAX_LENGTH))).toEqual([]);
  });

  it('rejects an oversized description', () => {
    expect(validateTemplateDescription('d'.repeat(TEMPLATE_DESCRIPTION_MAX_LENGTH + 1))).toEqual([
      { code: 'templateDescriptionTooLong', field: 'description' },
    ]);
  });
});
