import { useState } from 'react';

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
  onConfirm: (memberName: string) => void | Promise<void>;
}

export const RemoveMemberConfirmDialog = ({
  memberName,
  onCancel,
  onConfirm,
}: Readonly<Props>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const confirm = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onConfirm(memberName);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('detail.removeMember.title')}</DialogTitle>
          <DialogDescription>
            {t('detail.removeMember.description', { member: memberName })}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
            {t('detail.actions.cancel')}
          </Button>
          <Button variant="destructive" size="sm" disabled={pending} onClick={() => void confirm()}>
            {t('detail.actions.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
