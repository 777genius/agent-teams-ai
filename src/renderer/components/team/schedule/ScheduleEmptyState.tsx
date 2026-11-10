import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Calendar } from 'lucide-react';

export const ScheduleEmptyState = (): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <Calendar className="size-8 text-[var(--color-text-muted)]" />
      <div className="space-y-1">
        <p className="text-xs font-medium text-[var(--color-text-secondary)]">
          {t('schedule.empty.title')}
        </p>
        <p className="text-[11px] text-[var(--color-text-muted)]">
          {t('schedule.empty.description')}
        </p>
      </div>
    </div>
  );
};
