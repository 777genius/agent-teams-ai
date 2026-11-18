import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

interface ReviewFlowDefaultsErrorBannerProps {
  /** Why the saved default could not be read. */
  message: string;
  /** Offered where the default is not already being edited, to jump to it. */
  onFix?: () => void;
  /** The default itself is being edited right below, so say what its form shows. */
  editing?: boolean;
}

/** The saved default for all teams is unreadable: review actions are paused until a new one is saved. */
export const ReviewFlowDefaultsErrorBanner = ({
  message,
  onFix,
  editing = false,
}: Readonly<ReviewFlowDefaultsErrorBannerProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div
      role="alert"
      className="space-y-1.5 rounded-md border border-red-500/30 bg-red-500/10 p-2.5"
      data-testid="review-flow-defaults-error"
    >
      <p className="text-sm text-red-400">{t('reviewFlow.broken.defaults')}</p>
      <p className="text-xs text-[var(--color-text-muted)]">
        {t('reviewFlow.broken.details', { message })}
      </p>
      {editing ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t('reviewFlow.broken.defaultsHint')}
        </p>
      ) : null}
      {onFix ? (
        <Button type="button" size="sm" variant="outline" onClick={onFix}>
          {t('reviewFlow.broken.fixDefaults')}
        </Button>
      ) : null}
    </div>
  );
};
