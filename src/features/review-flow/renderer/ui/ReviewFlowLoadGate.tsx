import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

import type { ReviewFlowLoadStatus } from '../state/createReviewFlowStore';

interface ReviewFlowLoadGateProps {
  status: ReviewFlowLoadStatus;
  error: string | null;
  onRetry: () => void;
  children: React.ReactNode;
}

/** Shows children only once review-flow data is available; otherwise a skeleton or a retryable error. */
export const ReviewFlowLoadGate = ({
  status,
  error,
  onRetry,
  children,
}: Readonly<ReviewFlowLoadGateProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  if (status === 'ready') return <>{children}</>;

  if (status === 'error') {
    return (
      <div className="space-y-2" role="alert" data-testid="review-flow-load-error">
        <p className="text-sm text-red-400">
          {t('reviewFlow.loadError', { message: error ?? '' })}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          {t('reviewFlow.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2" role="status" aria-busy="true" data-testid="review-flow-loading">
      <span className="sr-only">{t('reviewFlow.loading')}</span>
      <div className="h-4 w-1/2 animate-pulse rounded bg-[var(--color-surface-raised)]" />
      <div className="h-16 animate-pulse rounded bg-[var(--color-surface-raised)]" />
      <div className="h-16 animate-pulse rounded bg-[var(--color-surface-raised)]" />
    </div>
  );
};
