import { useAppTranslation } from '@features/localization/renderer';
import { Label } from '@renderer/components/ui/label';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';

export interface CreateTeamPromptFieldProps {
  id?: string;
  promptDraft: { value: string; isSaved: boolean; setValue(value: string): void };
  chipDraft: {
    chips: InlineChip[];
    removeChip(id: string): void;
    addChip(chip: InlineChip): void;
  };
  soloTeam: boolean;
  mentionSuggestions: MentionSuggestion[];
  teamSuggestions: MentionSuggestion[];
  taskSuggestions: MentionSuggestion[];
  projectPath: string | null;
  onSuggestionsNeeded?(): void;
}

/** Same prompt editor for launched and template-created configuration-only teams. */
export function CreateTeamPromptField({
  id = 'team-prompt',
  promptDraft,
  chipDraft,
  soloTeam,
  mentionSuggestions,
  teamSuggestions,
  taskSuggestions,
  projectPath,
  onSuggestionsNeeded,
}: CreateTeamPromptFieldProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t('create.fields.prompt')}</Label>
      <MentionableTextarea
        id={id}
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
        onFocus={onSuggestionsNeeded}
        placeholder={t('create.placeholders.prompt')}
        footerRight={
          promptDraft.isSaved ? (
            <span className="text-[10px] text-[var(--color-text-muted)]">
              {t('create.saved')}
            </span>
          ) : null
        }
      />
    </div>
  );
}
