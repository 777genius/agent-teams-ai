import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

interface Props {
  memberName: string;
  onCancel: () => void;
  onConfirm: (memberName: string) => void;
}

export const RemoveMemberConfirmDialog = ({
  memberName,
  onCancel,
  onConfirm,
}: Readonly<Props>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('detail.removeMember.title')}</DialogTitle>
          <DialogDescription>
            {t('detail.removeMember.description', { member: memberName })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('detail.actions.cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onConfirm(memberName)}>
            {t('detail.actions.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
