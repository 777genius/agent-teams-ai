import React, { useState } from 'react';

import { CreateTeamTemplatePicker } from '@features/custom-team-templates/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Layers3 } from 'lucide-react';

import { applyTemplateToCreateTeam } from './applyTemplateToCreateTeam';
import { buildDefaultTeamDescription } from './createTeamDescription';
import { hasExistingCreateTeamDraftContent } from './hasExistingCreateTeamDraftContent';

import type { UseCreateTeamTemplateSelectionResult } from './useCreateTeamTemplateSelection';
import type { UseCreateTeamDraftResult } from '@renderer/hooks/useCreateTeamDraft';

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
  disabled?: boolean;
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
export const CreateTeamTemplateSelectionField = ({
  open,
  disabled = false,
  isCopy,
  form,
  templateSelection,
  descriptionDraft,
  promptDraft,
  promptChipDraft,
}: Readonly<Props>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [pickerOpen, setPickerOpen] = useState(false);
  React.useEffect(() => {
    if (!open) setPickerOpen(false);
  }, [open]);
  const confirmBeforeApply = hasExistingCreateTeamDraftContent({
    form,
    description: descriptionDraft.value,
    prompt: promptDraft.value,
    defaultDescription: buildDefaultTeamDescription(),
    hasPromptChips: promptChipDraft.chips.length > 0,
  });

  return (
    <Dialog open={open && pickerOpen} onOpenChange={setPickerOpen}>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => setPickerOpen(true)}
        data-testid="open-create-template-picker"
      >
        <Layers3 className="size-4" />
        {t('customTemplates.bulk.chooseTemplate')}
      </Button>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('customTemplates.bulk.chooseTemplate')}</DialogTitle>
          <DialogDescription>
            {t('customTemplates.createFromTemplate.description')}
          </DialogDescription>
        </DialogHeader>
        <CreateTeamTemplatePicker
          confirmBeforeApply={confirmBeforeApply}
          open={open && pickerOpen}
          disabled={disabled}
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
          onApply={(draft, source, value) => {
            applyTemplateToCreateTeam(draft, source, value, {
              templateSelection,
              descriptionDraft,
              promptDraft,
              promptChipDraft,
              setMembers: form.setMembers,
              setLaunchTeam: form.setLaunchTeam,
              setSoloTeam: form.setSoloTeam,
              setSyncModelsWithLead: form.setSyncModelsWithLead,
            });
            setPickerOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
};
