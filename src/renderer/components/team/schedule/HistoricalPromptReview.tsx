import React from 'react';
import { useAppTranslation } from '@features/localization/renderer';

interface HistoricalPromptReviewProps {
  prompt: string;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
}

/** Explicit opt-in. Saved launch instructions remain untouched. */
export function HistoricalPromptReview({
  prompt, confirmed, onConfirmedChange,
}: HistoricalPromptReviewProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  return (
    <section className="space-y-2 rounded-md border border-[var(--warning-border)] p-3">
      <p className="text-xs text-[var(--warning-text)]">
        {t('launch.schedule.historicalPromptReviewRequired')}
      </p>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface-raised)] p-2 text-xs">
        {prompt}
      </pre>
      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <input type="checkbox" checked={confirmed} onChange={(event) => onConfirmedChange(event.target.checked)} />
        <span>{t('launch.schedule.historicalPromptAcknowledged')}</span>
      </label>
    </section>
  );
}
