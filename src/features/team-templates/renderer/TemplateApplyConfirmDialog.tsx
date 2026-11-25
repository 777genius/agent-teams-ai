import { useAppTranslation } from '@features/localization/renderer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog';
import { buttonVariants } from '@renderer/components/ui/button';

interface Props {
  open: boolean;
  onCancel(): void;
  onConfirm(): void;
}

/** Shared confirmation for both Create Team template entry points. */
export function TemplateApplyConfirmDialog({
  open,
  onCancel,
  onConfirm,
}: Readonly<Props>): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('templates.confirmTitle', { defaultValue: 'Apply team template?' })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('templates.confirmMessage', {
              defaultValue:
                'This will replace your teammates, instructions and team settings with the template’s values.',
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tCommon('actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction className={buttonVariants({ variant: 'default' })} onClick={onConfirm}>
            {t('templates.confirmAction', { defaultValue: 'Apply template' })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
