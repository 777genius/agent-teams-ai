import { buildInitialRosterMemberDrafts } from './createTeamInitialRoster';

import type { UseCreateTeamTemplateSelectionResult } from './useCreateTeamTemplateSelection';
import type { CreateTeamTemplatePickerProps } from '@features/custom-team-templates/renderer';
import type { MemberDraft } from '@renderer/components/team/members/MembersEditorSection';

interface TemplateApplication {
  templateSelection: UseCreateTeamTemplateSelectionResult;
  descriptionDraft: { setValue(value: string): void };
  promptDraft: { setValue(value: string): void };
  promptChipDraft: { clearChipDraft(): void };
  setMembers(members: MemberDraft[]): void;
  setLaunchTeam(value: boolean): void;
  setSoloTeam(value: boolean): void;
  setSyncModelsWithLead(value: boolean, options: { persistStoredPreference: boolean }): void;
}

/** Apply only portable template fields to the existing creation draft. */
export function applyTemplateToCreateTeam(
  draft: Parameters<CreateTeamTemplatePickerProps['onApply']>[0],
  source: Parameters<CreateTeamTemplatePickerProps['onApply']>[1],
  value: string | undefined,
  options: TemplateApplication
): void {
  const {
    templateSelection,
    descriptionDraft,
    promptDraft,
    promptChipDraft,
    setMembers,
    setLaunchTeam,
    setSoloTeam,
    setSyncModelsWithLead,
  } = options;
  templateSelection.setAppliedTemplateSource(source);
  templateSelection.templateSelectionDraft.setValue(JSON.stringify({ source, value: value ?? '' }));
  if (source !== 'none') {
    setLaunchTeam(false);
    setSoloTeam(false);
    setSyncModelsWithLead(true, { persistStoredPreference: false });
  }
  descriptionDraft.setValue(draft.description ?? '');
  promptDraft.setValue(draft.prompt ?? '');
  promptChipDraft.clearChipDraft();
  setMembers(
    buildInitialRosterMemberDrafts({ copiedMembers: draft.members, multimodelEnabled: true })
  );
}
