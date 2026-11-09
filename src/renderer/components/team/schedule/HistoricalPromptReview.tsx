import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';

interface HistoricalPromptReviewProps {
  readonly prompt: string;
  readonly confirmed: boolean;
  readonly onConfirmedChange: (confirmed: boolean) => void;
}

/** Saved instructions remain intact; acknowledgement authorizes only non-replay. */
export const HistoricalPromptReview = ({
  prompt, confirmed, onConfirmedChange,
}: HistoricalPromptReviewProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <section className="space-y-2 rounded-md border border-[var(--warning-border)] p-3">
      <p className="text-xs text-[var(--warning-text)]">
        {t('launch.schedule.historicalPromptReviewRequired')}
      </p>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface-raised)] p-2 text-xs">
        {prompt}
      </pre>
      <div className="flex items-start gap-2">
        <Checkbox
          id="schedule-saved-prompt-reviewed"
          checked={confirmed}
          onCheckedChange={(value) => onConfirmedChange(value === true)}
        />
        <Label htmlFor="schedule-saved-prompt-reviewed" className="cursor-pointer text-xs font-normal">
          {t('launch.schedule.historicalPromptAcknowledged')}
        </Label>
      </div>
    </section>
  );
};
