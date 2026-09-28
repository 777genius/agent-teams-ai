import { useAppTranslation } from '@features/localization/renderer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Loader2 } from 'lucide-react';

interface CreateTeamDialogLoadingFallbackProps {
  readonly isCopy: boolean;
  readonly onClose: () => void;
}

export const CreateTeamDialogLoadingFallback = ({
  isCopy,
  onClose,
}: CreateTeamDialogLoadingFallbackProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isCopy ? t('create.title.copy') : t('create.title.create')}
          </DialogTitle>
          <DialogDescription className="sr-only" aria-live="polite">
            {tCommon('states.loading')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          <Loader2 className="size-3.5 animate-spin" />
          <span>{tCommon('states.loading')}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
};
