import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Loader2 } from 'lucide-react';

export const CreateTeamPageLoadingFallback = ({
  isCopy,
  onClose,
}: Readonly<{
  isCopy: boolean;
  onClose: () => void;
}>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: common } = useAppTranslation('common');
  return (
    <div data-testid="create-team-page" className="size-full min-h-0 overflow-auto">
      <header className="flex items-center gap-3 border-b border-[var(--color-border)] p-4">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('list.title')}
        </Button>
        <h1 className="text-base font-semibold">
          {isCopy ? t('create.title.copy') : t('create.title.create')}
        </h1>
      </header>
      <div
        role="status"
        className="flex items-center gap-2 p-6 text-xs text-[var(--color-text-muted)]"
      >
        <Loader2 className="size-3.5 animate-spin" />
        {common('states.loading')}
      </div>
    </div>
  );
};
