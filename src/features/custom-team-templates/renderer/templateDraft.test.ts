import { TEAM_TEMPLATES } from '@features/team-templates';

import {
  applyCustomTeamTemplate,
  applyNoTeamTemplate,
  builtinTemplateSelectionValue,
  CREATE_TEAM_TEMPLATE_NONE_VALUE,
  customTemplateSelectionValue,
  parseTemplateSelectionValue,
  resolveCreateTeamTemplateDraft,
} from './templateDraft';

import type { CustomTeamTemplateV1 } from '../contracts';

function customRecord(): CustomTeamTemplateV1 {
  return {
    templateId: 'tmpl-custom-1',
    name: 'Custom One',
    description: 'Custom description',
    schemaVersion: 1,
    teamPrompt: 'Custom prompt',
    members: [
      { name: 'backend-dev', role: 'Backend Developer', workflow: 'Build APIs' },
      { name: 'reviewer', role: 'Reviewer', workflow: 'Review changes' },
    ],
    revision: 3,
    createdAt: '2026-09-10T10:00:00.000Z',
  };
}

describe('templateDraft', () => {
  it('parses picker selection values', () => {
    expect(parseTemplateSelectionValue(CREATE_TEAM_TEMPLATE_NONE_VALUE)).toEqual({
      kind: 'none',
    });
    expect(parseTemplateSelectionValue(builtinTemplateSelectionValue('marketing'))).toEqual({
      kind: 'builtin',
      builtinTemplateId: 'marketing',
    });
    expect(parseTemplateSelectionValue(customTemplateSelectionValue('tmpl-1'))).toEqual({
      kind: 'custom',
      templateId: 'tmpl-1',
    });
    expect(parseTemplateSelectionValue('bogus')).toEqual({
      kind: 'unknown',
      value: 'bogus',
    });
  });

  it('resolves the no-template selection to a blank draft', () => {
    const result = resolveCreateTeamTemplateDraft(CREATE_TEAM_TEMPLATE_NONE_VALUE, {
      builtins: TEAM_TEMPLATES,
      customs: [customRecord()],
    });
    expect(result).toEqual({ status: 'none', draft: applyNoTeamTemplate() });
    expect(applyNoTeamTemplate()).toEqual({
      runtimeSelectionVersion: 1,
      description: '',
      prompt: '',
      members: [],
      syncModelsWithLead: true,
    });
  });

  it('resolves a built-in selection through the closed catalogue', () => {
    const result = resolveCreateTeamTemplateDraft(builtinTemplateSelectionValue('marketing'), {
      builtins: TEAM_TEMPLATES,
      customs: [],
    });
    expect(result.status).toBe('builtin');
    if (result.status !== 'builtin') return;
    expect(result.builtinTemplateId).toBe('marketing');
    const marketing = TEAM_TEMPLATES.find((entry) => entry.id === 'marketing');
    expect(result.draft.description).toBe(marketing?.description);
    expect(result.draft.prompt).toBe(marketing?.teamPrompt);
    expect(result.draft.members.map((member) => member.name)).toEqual(
      marketing?.members.map((member) => member.name)
    );
    expect(result.draft.runtimeSelectionVersion).toBe(1);
  });

  it('never resolves a built-in id outside the closed catalogue', () => {
    const result = resolveCreateTeamTemplateDraft('builtin:not-a-template', {
      builtins: TEAM_TEMPLATES,
      customs: [],
    });
    expect(result).toEqual({ status: 'builtinNotFound', value: 'builtin:not-a-template' });
  });

  it('resolves a custom selection to allowlisted content with its revision', () => {
    const record = customRecord();
    const result = resolveCreateTeamTemplateDraft(customTemplateSelectionValue(record.templateId), {
      builtins: TEAM_TEMPLATES,
      customs: [record],
    });
    expect(result.status).toBe('custom');
    if (result.status !== 'custom') return;
    expect(result.templateId).toBe(record.templateId);
    expect(result.revision).toBe(3);
    expect(result.draft).toEqual(applyCustomTeamTemplate(record));
    expect(result.draft.description).toBe('Custom description');
    expect(result.draft.prompt).toBe('Custom prompt');
    expect(result.draft.members).toEqual([
      { name: 'backend-dev', role: 'Backend Developer', workflow: 'Build APIs' },
      { name: 'reviewer', role: 'Reviewer', workflow: 'Review changes' },
    ]);
  });

  it('reports a custom id missing from the loaded library as not found', () => {
    const result = resolveCreateTeamTemplateDraft(customTemplateSelectionValue('tmpl-deleted'), {
      builtins: TEAM_TEMPLATES,
      customs: [customRecord()],
    });
    expect(result).toEqual({
      status: 'customNotFound',
      value: customTemplateSelectionValue('tmpl-deleted'),
    });
  });

  it('copies template content without sharing references or identity', () => {
    const record = customRecord();
    const before = JSON.parse(JSON.stringify(record)) as CustomTeamTemplateV1;
    const draft = applyCustomTeamTemplate(record);

    // The draft carries no template identity, timestamps or revision.
    expect(draft).not.toHaveProperty('templateId');
    expect(draft).not.toHaveProperty('revision');
    expect(draft).not.toHaveProperty('createdAt');
    expect(draft).not.toHaveProperty('name');
    for (const member of draft.members) {
      expect(Object.keys(member).sort()).toEqual(['name', 'role', 'workflow']);
    }

    // Mutating the draft never mutates the source template.
    draft.description = 'changed';
    draft.prompt = 'changed';
    draft.members.push({ name: 'intruder' });
    draft.members[0].name = 'changed';
    expect(record).toEqual(before);
  });
});
