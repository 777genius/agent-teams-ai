import { useAppTranslation } from '@features/localization/renderer';

import type { TeamManagementCommittedChange } from '@features/team-prompt-management/contracts';

/** Show server-computed field keys/counts, never agent-authored explanations or prompts. */
export const TeamManagementNotice = ({
  change,
}: Readonly<{ change?: TeamManagementCommittedChange }>) => {
  const { t } = useAppTranslation('team');
  if (!change || change.kind === 'trashed') return null;
  const facts: string[] = change.changedFields.flatMap((field) => {
    if (field === 'deletedAt' || (field === 'members' && change.roster)) return [];
    return [t(`managementChanges.fields.${field}`)];
  });
  if (change.roster)
    facts.unshift(
      t('managementChanges.roster', {
        added: change.roster.added,
        removed: change.roster.removed,
      })
    );
  return (
    <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
      <span className="mr-2 rounded bg-[var(--color-surface-overlay)] px-1.5 py-0.5 font-medium">
        {t(`managementChanges.${change.kind}`)}
      </span>
      <span className="line-clamp-1">{facts.join('; ')}</span>
    </div>
  );
};
