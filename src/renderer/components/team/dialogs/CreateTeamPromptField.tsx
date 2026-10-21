import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Label } from '@renderer/components/ui/label';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { InlineChip } from '@shared/types/inlineChip';

/** Structural view of the dialog-owned draft persistence for the prompt text. */
export interface PromptDraftControl {
  value: string;
  isSaved: boolean;
  setValue: (value: string) => void;
}

/** Structural view of the dialog-owned chip draft persistence. */
export interface PromptChipDraftControl {
  chips: InlineChip[];
  removeChip: (chipId: string) => void;
  addChip: (chip: InlineChip) => void;
}

export interface CreateTeamPromptFieldProps {
  promptDraft: PromptDraftControl;
  chipDraft: PromptChipDraftControl;
  soloTeam: boolean;
  mentionSuggestions: MentionSuggestion[];
  teamSuggestions: MentionSuggestion[];
  taskSuggestions: MentionSuggestion[];
  projectPath: string | null;
}

/**
 * The team-lead prompt input used by team creation.
 *
 * A single field serves every creation mode: the dialog renders it once —
 * never as duplicates — whenever the prompt can affect the creation payload
 * (launch flow, or config-only creation driven by a team template). The
 * controlled drafts behind it stay owned by the dialog.
 */
export const CreateTeamPromptField = ({
  promptDraft,
  chipDraft,
  soloTeam,
  mentionSuggestions,
  teamSuggestions,
  taskSuggestions,
  projectPath,
}: CreateTeamPromptFieldProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <div className="space-y-1.5">
      <Label htmlFor="team-prompt" className="label-optional">
        {t('create.fields.prompt')}
      </Label>
      <MentionableTextarea
        id="team-prompt"
        className="text-xs"
        minRows={3}
        maxRows={12}
        value={promptDraft.value}
        onValueChange={promptDraft.setValue}
        suggestions={soloTeam ? [] : mentionSuggestions}
        teamSuggestions={teamSuggestions}
        taskSuggestions={taskSuggestions}
        projectPath={projectPath}
        chips={chipDraft.chips}
        onChipRemove={chipDraft.removeChip}
        onFileChipInsert={chipDraft.addChip}
        placeholder={t('create.placeholders.prompt')}
        footerRight={
          promptDraft.isSaved ? (
            <span className="text-[10px] text-[var(--color-text-muted)]">{t('create.saved')}</span>
          ) : null
        }
      />
    </div>
  );
};
