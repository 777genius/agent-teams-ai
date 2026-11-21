import React from 'react';

import { CreateTeamTemplatePicker } from '@features/custom-team-templates/renderer';

import { applyTemplateToCreateTeam } from './applyTemplateToCreateTeam';
import { buildDefaultTeamDescription } from './createTeamDescription';
import { hasExistingCreateTeamDraftContent } from './hasExistingCreateTeamDraftContent';

import type { UseCreateTeamDraftResult } from '@renderer/hooks/useCreateTeamDraft';
import type { UseCreateTeamTemplateSelectionResult } from './useCreateTeamTemplateSelection';

interface TemplateTextDraft {
  value: string;
  isLoaded: boolean;
  setValue(value: string): void;
}

interface TemplateChipDraft {
  chips: readonly unknown[];
  clearChipDraft(): void;
}

interface Props {
  open: boolean;
  isCopy: boolean;
  form: Pick<
    UseCreateTeamDraftResult,
    | 'isLoaded'
    | 'members'
    | 'runtimeProviderId'
    | 'soloTeam'
    | 'syncModelsWithLead'
    | 'setMembers'
    | 'setLaunchTeam'
    | 'setSoloTeam'
    | 'setRuntimeSelection'
    | 'setSyncModelsWithLead'
  >;
  templateSelection: UseCreateTeamTemplateSelectionResult;
  descriptionDraft: TemplateTextDraft;
  promptDraft: TemplateTextDraft;
  promptChipDraft: TemplateChipDraft;
}

/**
 * Adapts the feature-owned picker to the existing Create Team draft.
 * Template application remains in its shared helper; this boundary only binds
 * state/handlers and preserves the Copy Team hydration fence.
 */
export function CreateTeamTemplateSelectionField({
  open,
  isCopy,
  form,
  templateSelection,
  descriptionDraft,
  promptDraft,
  promptChipDraft,
}: Props): React.JSX.Element {
  const confirmBeforeApply = hasExistingCreateTeamDraftContent({
    form,
    description: descriptionDraft.value,
    prompt: promptDraft.value,
    defaultDescription: buildDefaultTeamDescription(),
    hasPromptChips: promptChipDraft.chips.length > 0,
  });

  return (
    <CreateTeamTemplatePicker
      confirmBeforeApply={confirmBeforeApply}
      open={open}
      initialSelection={
        isCopy && templateSelection.appliedTemplateSource === 'none'
          ? ''
          : templateSelection.storedTemplateSelection.value
      }
      initialSelectionReady={
        form.isLoaded &&
        templateSelection.templateSelectionDraft.isLoaded &&
        descriptionDraft.isLoaded &&
        promptDraft.isLoaded
      }
      onApply={(draft, source, value) =>
        applyTemplateToCreateTeam(draft, source, value, {
          templateSelection,
          descriptionDraft,
          promptDraft,
          promptChipDraft,
          setMembers: form.setMembers,
          setLaunchTeam: form.setLaunchTeam,
          setSoloTeam: form.setSoloTeam,
          setRuntimeSelection: form.setRuntimeSelection,
          setSyncModelsWithLead: form.setSyncModelsWithLead,
        })
      }
    />
  );
}
