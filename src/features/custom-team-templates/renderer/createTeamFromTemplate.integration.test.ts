import { TEAM_TEMPLATES } from '@features/team-templates';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { buildInitialRosterMemberDrafts } from '@renderer/components/team/dialogs/createTeamInitialRoster';
import { buildMembersFromDrafts } from '@renderer/components/team/members/membersEditorUtils';

import {
  applyCustomTeamTemplate,
  builtinTemplateSelectionValue,
  CREATE_TEAM_TEMPLATE_NONE_VALUE,
  customTemplateSelectionValue,
  resolveCreateTeamTemplateDraft,
} from './templateDraft';

import type { CustomTeamTemplateV1 } from '../contracts';
import type { TeamCreateRequest } from '@shared/types';

function customRecord(): CustomTeamTemplateV1 {
  return {
    templateId: 'tmpl-custom-7',
    name: 'Custom Seven',
    description: 'Custom seven description',
    schemaVersion: 1,
    teamPrompt: 'Custom seven prompt',
    members: [
      { name: 'backend-dev', role: 'Backend Developer', workflow: 'Build APIs' },
      { name: 'reviewer', role: 'Reviewer', workflow: 'Review changes' },
    ],
    revision: 4,
    createdAt: '2026-09-10T10:00:00.000Z',
  };
}

/**
 * Mirrors CreateTeamDialog's onApply + request pipeline: the resolved draft
 * becomes roster drafts (fresh dialog-owned ids via createMemberDraft) and is
 * then serialized back to TeamProvisioningMemberInput for the team:create /
 * team:createConfig payload.
 */
function buildPayloadMembers(
  draft: ReturnType<typeof applyCustomTeamTemplate>
): TeamCreateRequest['members'] {
  const roster = buildInitialRosterMemberDrafts({
    copiedMembers: draft.members,
    multimodelEnabled: true,
  });
  return buildMembersFromDrafts(roster, { inheritedProviderId: undefined });
}

describe('createTeamFromTemplate integration', () => {
  it('produces the intended team:create payload from a built-in template', () => {
    const result = resolveCreateTeamTemplateDraft(builtinTemplateSelectionValue('marketing'), {
      builtins: TEAM_TEMPLATES,
      customs: [],
    });
    expect(result.status).toBe('builtin');
    if (result.status !== 'builtin') return;

    const catalogue = TEAM_TEMPLATES.find((entry) => entry.id === 'marketing');
    const members = buildPayloadMembers(result.draft);

    expect(result.draft.description).toBe(catalogue?.description);
    expect(result.draft.prompt).toBe(catalogue?.teamPrompt);
    expect(members.map((member) => member.name)).toEqual(
      catalogue?.members.map((member) => member.name)
    );
    expect(members.map((member) => member.role)).toEqual(
      catalogue?.members.map((member) => member.role)
    );
    // No identity survives into the payload: backend generates all ids.
    for (const member of members) {
      expect(member).not.toHaveProperty('id');
      expect(member).not.toHaveProperty('templateId');
    }
    const payload = {
      teamName: 'marketing-team',
      description: result.draft.description,
      prompt: result.draft.prompt,
      members,
    } as Record<string, unknown>;
    expect(payload).not.toHaveProperty('templateId');
    expect(payload).not.toHaveProperty('revision');
  });

  it('produces the intended payload from persisted custom data and leaves the source unchanged', () => {
    const record = customRecord();
    const before = JSON.parse(JSON.stringify(record)) as CustomTeamTemplateV1;
    const result = resolveCreateTeamTemplateDraft(customTemplateSelectionValue(record.templateId), {
      builtins: TEAM_TEMPLATES,
      customs: [record],
    });
    expect(result.status).toBe('custom');
    if (result.status !== 'custom') return;

    const members = buildPayloadMembers(result.draft);
    expect(result.draft.description).toBe('Custom seven description');
    expect(result.draft.prompt).toBe('Custom seven prompt');
    expect(members).toEqual([
      { name: 'backend-dev', role: 'Backend Developer', workflow: 'Build APIs' },
      { name: 'reviewer', role: 'Reviewer', workflow: 'Review changes' },
    ]);

    // The applied draft is a snapshot: editing it never touches the source.
    result.draft.description = 'edited';
    result.draft.prompt = 'edited';
    result.draft.members.push({ name: 'intruder' });
    expect(record).toEqual(before);

    // Rebuilding from the unedited snapshot still yields the template content.
    const replay = buildPayloadMembers({
      runtimeSelectionVersion: 1,
      description: 'Custom seven description',
      prompt: 'Custom seven prompt',
      members: before.members.map((member) => ({ ...member })),
      syncModelsWithLead: true,
    });
    expect(replay).toEqual(members);
  });

  it('keeps the no-template path on the original blank workflow', () => {
    const result = resolveCreateTeamTemplateDraft(CREATE_TEAM_TEMPLATE_NONE_VALUE, {
      builtins: TEAM_TEMPLATES,
      customs: [customRecord()],
    });
    expect(result.status).toBe('none');
    if (result.status !== 'none') return;

    expect(buildPayloadMembers(result.draft)).toEqual([]);
    expect(result.draft.description).toBe('');
    expect(result.draft.prompt).toBe('');
  });

  it('never copies runtime state and never launches execution from a template', () => {
    const result = resolveCreateTeamTemplateDraft(builtinTemplateSelectionValue('research'), {
      builtins: TEAM_TEMPLATES,
      customs: [],
    });
    expect(result.status).toBe('builtin');
    if (result.status !== 'builtin') return;

    // The draft carries only allowlisted creation fields plus fixed defaults.
    expect(Object.keys(result.draft).sort()).toEqual(
      ['description', 'members', 'prompt', 'runtimeSelectionVersion', 'syncModelsWithLead'].sort()
    );
    for (const key of ['tasks', 'messages', 'sessions', 'history', 'launch', 'teamId']) {
      expect(result.draft).not.toHaveProperty(key);
    }
    // Creation and launch stay separate entrypoints on the canonical service.
    expect(TeamProvisioningService.prototype.createTeam).toBeDefined();
    expect(TeamProvisioningService.prototype.launchTeam).toBeDefined();
    expect(TeamProvisioningService.prototype.createTeam).not.toBe(
      TeamProvisioningService.prototype.launchTeam
    );
  });

  it('applies nothing for a deleted custom template so the caller can recover', () => {
    const result = resolveCreateTeamTemplateDraft(customTemplateSelectionValue('tmpl-deleted'), {
      builtins: TEAM_TEMPLATES,
      customs: [customRecord()],
    });
    expect(result).toEqual({
      status: 'customNotFound',
      value: customTemplateSelectionValue('tmpl-deleted'),
    });
    expect(result).not.toHaveProperty('draft');
  });

  it('keeps user edits after apply: the form stays editable before submission', () => {
    const result = resolveCreateTeamTemplateDraft(builtinTemplateSelectionValue('research'), {
      builtins: TEAM_TEMPLATES,
      customs: [],
    });
    expect(result.status).toBe('builtin');
    if (result.status !== 'builtin') return;

    // Simulate the user editing the prefilled form before submitting.
    const editedDraft = {
      ...result.draft,
      description: 'My edited description',
      members: [...result.draft.members, { name: 'extra-dev', role: 'Engineer' }],
    };
    const members = buildPayloadMembers(editedDraft);
    expect(members.map((member) => member.name)).toContain('extra-dev');
    expect(editedDraft.description).toBe('My edited description');
  });
});
