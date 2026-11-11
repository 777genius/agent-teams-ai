import { TeamTemplatePicker } from '@features/team-templates/renderer';

import { buildInitialRosterMemberDrafts } from './createTeamInitialRoster';

import type { UseCreateTeamDraftResult } from '@renderer/hooks/useCreateTeamDraft';

interface TextDraft {
  value: string;
  isLoaded: boolean;
  setValue: (value: string) => void;
}

interface CreateTeamTemplatePickerProps {
  form: Pick<
    UseCreateTeamDraftResult,
    | 'members'
    | 'runtimeProviderId'
    | 'soloTeam'
    | 'syncModelsWithLead'
    | 'isLoaded'
    | 'setRuntimeSelection'
    | 'setLaunchTeam'
    | 'setSoloTeam'
    | 'setSyncModelsWithLead'
    | 'setMembers'
  >;
  descriptionDraft: TextDraft;
  promptDraft: TextDraft;
  defaultDescription: string;
  hasPromptChips: boolean;
  clearPromptChips: () => void;
  disabled?: boolean;
}

/** Owns the create form's replacement boundary; cancellation never mutates the draft. */
export const CreateTeamTemplatePicker = ({
  form,
  descriptionDraft,
  promptDraft,
  defaultDescription,
  hasPromptChips,
  clearPromptChips,
  disabled,
}: CreateTeamTemplatePickerProps): React.JSX.Element => {
  const description = descriptionDraft.value.trim();
  const hasExistingContent =
    form.members.length > 0 ||
    (description.length > 0 && description !== defaultDescription.trim()) ||
    promptDraft.value.length > 0 ||
    hasPromptChips ||
    Boolean(form.runtimeProviderId) ||
    form.soloTeam ||
    !form.syncModelsWithLead;

  return (
    <TeamTemplatePicker
      confirmBeforeApply={hasExistingContent}
      disabled={disabled || !form.isLoaded || !descriptionDraft.isLoaded || !promptDraft.isLoaded}
      onApply={(draft) => {
        form.setRuntimeSelection(1);
        form.setLaunchTeam(false);
        form.setSoloTeam(false);
        form.setSyncModelsWithLead(true, { persistStoredPreference: false });
        descriptionDraft.setValue(draft.description ?? '');
        // Per-key mutation ordering retires old chips before new prompt saves.
        clearPromptChips();
        promptDraft.setValue(draft.prompt ?? '');
        form.setMembers(
          buildInitialRosterMemberDrafts({
            copiedMembers: draft.members,
            multimodelEnabled: true,
          })
        );
      }}
    />
  );
};
