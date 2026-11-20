import { useAppTranslation } from '@features/localization/renderer';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';

import type { TeamProjectContextMode } from '@shared/types';
import type { JSX } from 'react';

interface Props {
  value: TeamProjectContextMode;
  onValueChange(value: TeamProjectContextMode): void;
}

/** Creation-only: the history mode cannot be changed after the team is created. */
export const TeamHistoryModeField = ({ value, onValueChange }: Readonly<Props>): JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="space-y-2">
      <Label htmlFor="team-project-context-mode">{t('create.projectContextMode.label')}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === 'shared' || next === 'per_project') onValueChange(next);
        }}
      >
        <SelectTrigger
          id="team-project-context-mode"
          aria-label={t('create.projectContextMode.label')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="per_project">{t('create.projectContextMode.perProject')}</SelectItem>
          <SelectItem value="shared">{t('create.projectContextMode.shared')}</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-[var(--color-text-muted)]">
        {t('create.projectContextMode.description')}
      </p>
    </div>
  );
};
