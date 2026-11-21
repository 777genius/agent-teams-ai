import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import { describe, expect, it } from 'vitest';

import type {
  ConfirmCustomTeamTemplateSaveResult,
  CustomTeamTemplateV1,
  ListCustomTeamTemplatesResult,
  PrepareCustomTeamTemplatePreviewResult,
} from '@features/custom-team-templates/contracts';

/** Exhaustive switch proves the discriminated union has no unhandled outcome. */
function describePreviewResult(result: PrepareCustomTeamTemplatePreviewResult): string {
  switch (result.status) {
    case 'previewReady':
      return `preview:${result.preview.name}`;
    case 'sourceUnavailable':
      return `sourceUnavailable:${result.sourceTeamName}`;
    case 'rosterUnreadable':
      return `rosterUnreadable:${result.sourceTeamName}`;
    case 'validationFailed':
      return `validationFailed:${result.issues.map((issue) => issue.code).join(',')}`;
    case 'nameConflict':
      return `nameConflict:${result.existingTemplateId}`;
    case 'storageUnavailable':
      return 'storageUnavailable';
  }
}

function describeSaveResult(result: ConfirmCustomTeamTemplateSaveResult): string {
  switch (result.status) {
    case 'created':
      return `created:${result.template.templateId}`;
    case 'alreadySaved':
      return `alreadySaved:${result.template.templateId}`;
    case 'stalePreview':
      return `stalePreview:${result.sourceTeamName}`;
    case 'sourceUnavailable':
      return `sourceUnavailable:${result.sourceTeamName}`;
    case 'rosterUnreadable':
      return `rosterUnreadable:${result.sourceTeamName}`;
    case 'nameConflict':
      return `nameConflict:${result.existingTemplateId}`;
    case 'templateIdConflict':
      return `templateIdConflict:${result.templateId}`;
    case 'validationFailed':
      return `validationFailed:${result.issues.length}`;
    case 'storageUnavailable':
      return 'storageUnavailable';
    case 'unresolvedWriteOutcome':
      return `unresolvedWriteOutcome:${result.templateId}`;
  }
}

function describeListResult(result: ListCustomTeamTemplatesResult): string {
  switch (result.status) {
    case 'empty':
      return 'empty';
    case 'ready':
      return `ready:${result.templates.length}`;
    case 'hasUnreadableRecords':
      return `hasUnreadableRecords:${result.templates.length}/${result.unreadableRecords.length}`;
    case 'storageUnavailable':
      return 'storageUnavailable';
  }
}

const template: CustomTeamTemplateV1 = {
  schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
  templateId: 'template-1',
  name: 'Demo Template',
  teamPrompt: 'Coordinate.',
  members: [{ name: 'engineer', role: 'Engineer', workflow: 'Build.' }],
};

describe('custom team template contracts', () => {
  it('pins the contract schema version literal', () => {
    expect(CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION).toBe(1);
  });

  it('narrows prepare-preview outcomes', () => {
    expect(describePreviewResult({ status: 'sourceUnavailable', sourceTeamName: 'demo' })).toBe(
      'sourceUnavailable:demo'
    );
    expect(
      describePreviewResult({
        status: 'validationFailed',
        issues: [{ code: 'templateNameRequired', field: 'name' }],
      })
    ).toBe('validationFailed:templateNameRequired');
    expect(describePreviewResult({ status: 'nameConflict', existingTemplateId: 'template-1' })).toBe(
      'nameConflict:template-1'
    );
    expect(describePreviewResult({ status: 'storageUnavailable' })).toBe('storageUnavailable');
  });

  it('narrows confirm-save outcomes without conflating errors', () => {
    expect(describeSaveResult({ status: 'created', template })).toBe('created:template-1');
    expect(describeSaveResult({ status: 'alreadySaved', template })).toBe('alreadySaved:template-1');
    expect(describeSaveResult({ status: 'stalePreview', sourceTeamName: 'demo' })).toBe(
      'stalePreview:demo'
    );
    expect(describeSaveResult({ status: 'templateIdConflict', templateId: 'template-1' })).toBe(
      'templateIdConflict:template-1'
    );
    expect(
      describeSaveResult({ status: 'unresolvedWriteOutcome', templateId: 'template-1' })
    ).toBe('unresolvedWriteOutcome:template-1');
  });

  it('keeps an empty library distinct from an unavailable store', () => {
    expect(describeListResult({ status: 'empty' })).toBe('empty');
    expect(describeListResult({ status: 'storageUnavailable' })).toBe('storageUnavailable');
  });

  it('keeps a partially unreadable library readable', () => {
    expect(
      describeListResult({
        status: 'hasUnreadableRecords',
        templates: [template],
        unreadableRecords: [{ templateId: 'template-2', reason: 'unreadableRecord' }],
      })
    ).toBe('hasUnreadableRecords:1/1');
  });
});
