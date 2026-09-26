import { useAppTranslation } from '@features/localization/renderer';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog';
import { Loader2 } from 'lucide-react';

interface TaskDetailLoadingDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Lightweight loading shell for the task dialog. Kept out of TaskDetailDialog so it can be
 * shown instantly while the heavy dialog chunk is still being fetched.
 */
export const TaskDetailLoadingDialog = ({
  open,
  onClose,
}: TaskDetailLoadingDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="sm:max-w-4xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('taskDetail.loading.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <Loader2 className="size-4 animate-spin" />
          <span>{t('taskDetail.loading.fetchingTeamData')}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
};
