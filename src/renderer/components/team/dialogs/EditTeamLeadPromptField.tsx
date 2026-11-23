import { useAppTranslation } from '@features/localization/renderer';
import { MAX_TEAM_DEFINITION_TEXT_LENGTH } from '@shared/constants/teamLimits';

interface EditTeamLeadPromptFieldProps {
  value: string;
  onValueChange: (value: string) => void;
}

export const EditTeamLeadPromptField = ({ value, onValueChange }: EditTeamLeadPromptFieldProps) => {
  const { t } = useAppTranslation('team');

  return (
    <div>
      <label htmlFor="edit-team-lead-prompt" className="mb-1 block text-xs font-medium text-text">
        {t('editTeam.fields.leadPrompt')}
      </label>
      <textarea
        id="edit-team-lead-prompt"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        rows={4}
        maxLength={MAX_TEAM_DEFINITION_TEXT_LENGTH}
        aria-describedby="edit-team-lead-prompt-hint"
        className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-form-control-bg)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-border-emphasis)]"
        placeholder={t('editTeam.placeholders.leadPrompt')}
      />
      <p id="edit-team-lead-prompt-hint" className="mt-1 text-xs text-[var(--color-text-muted)]">
        {t('editTeam.leadPromptHint')}
      </p>
    </div>
  );
};
