import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

export const TaskDetailReviewRouteBanner = ({
  blocked,
  retry,
  close,
}: {
  blocked: boolean;
  retry: () => void;
  close: () => void;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const { t: common } = useAppTranslation('common');
  if (!blocked) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-3 border-b border-[var(--color-border)] bg-surface-raised px-4 py-2 text-sm"
    >
      <span className="flex-1">{t('taskDetail.navigation.reviewRefused')}</span>
      <Button variant="outline" size="sm" onClick={retry}>
        {common('actions.retry')}
      </Button>
      <Button variant="ghost" size="sm" onClick={close}>
        {common('actions.close')}
      </Button>
    </div>
  );
};
