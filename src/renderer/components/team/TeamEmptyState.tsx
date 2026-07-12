import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { FolderOpen } from 'lucide-react';

interface TeamEmptyStateProps {
  canCreate: boolean;
  onCreateTeam: () => void;
  onImportTeam?: () => void;
}

export const TeamEmptyState = ({
  canCreate,
  onCreateTeam,
  onImportTeam,
}: TeamEmptyStateProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="flex size-full items-center justify-center">
      <div className="text-center">
        <p className="text-lg font-medium text-[var(--color-text)]">{t('list.empty.title')}</p>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t('list.empty.description')}</p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button size="sm" disabled={!canCreate} onClick={onCreateTeam}>
            {t('list.actions.createTeam')}
          </Button>
          {onImportTeam ? (
            <Button size="sm" variant="outline" disabled={!canCreate} onClick={onImportTeam}>
              <FolderOpen className="mr-1.5 size-3.5" />
              {t('list.actions.importTeam')}
            </Button>
          ) : null}
        </div>
        {!canCreate ? (
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">{t('list.empty.localOnly')}</p>
        ) : null}
      </div>
    </div>
  );
};
