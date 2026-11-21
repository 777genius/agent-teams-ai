import React from 'react';

import { CreateTeamTemplatePicker } from '@features/custom-team-templates/renderer';

import { applyTemplateToCreateTeam } from './applyTemplateToCreateTeam';

import type { UseCreateTeamDraftResult } from '@renderer/hooks/useCreateTeamDraft';
import type { UseCreateTeamTemplateSelectionResult } from './useCreateTeamTemplateSelection';

interface TemplateTextDraft {
  setValue(value: string): void;
}

interface TemplateChipDraft {
  clearChipDraft(): void;
}

interface Props {
  open: boolean;
  isCopy: boolean;
  form: Pick<
    UseCreateTeamDraftResult,
    | 'isLoaded'
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
  return (
    <CreateTeamTemplatePicker
      open={open}
      initialSelection={
        isCopy && templateSelection.appliedTemplateSource === 'none'
          ? ''
          : templateSelection.storedTemplateSelection.value
      }
      initialSelectionReady={form.isLoaded && templateSelection.templateSelectionDraft.isLoaded}
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
