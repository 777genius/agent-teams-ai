import { useAppTranslation } from '@features/localization/renderer';

interface ViewedProgressBarProps {
  viewed: number;
  total: number;
  progress: number;
}

export const ViewedProgressBar = ({ viewed, total, progress }: ViewedProgressBarProps) => {
  const { t } = useAppTranslation('team');

  if (total === 0) return null;

  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-700/50">
        <div
          className="h-full rounded-full bg-green-500/70 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
      <span className="text-text-muted">{t('review.progress.viewed', { viewed, total })}</span>
    </div>
  );
};
