import { useEffect, useState } from 'react';

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
import { CheckCircle2 } from 'lucide-react';

import type { ExternalAgentConfirmation, ExternalAgentConnectionApi } from '../contracts';

export const ExternalAgentConfirmationDialog = ({
  api,
}: Readonly<{ api: ExternalAgentConnectionApi }>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const [confirmation, setConfirmation] = useState<ExternalAgentConfirmation | null>(null);

  useEffect(() => {
    const subscribe = api.onConfirmation;
    const getPending = api.getPendingConfirmation;
    if (!subscribe || !getPending) return;
    let active = true;
    let receivedEvent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((value) => {
      receivedEvent = true;
      clearTimeout(timer);
      if (active) setConfirmation(value);
    });
    const readPending = (): void => {
      void getPending()
        .then((value) => {
          if (active && !receivedEvent) setConfirmation(value);
        })
        .catch(() => {
          // The renderer can mount before the main-process handlers finish starting.
          if (active && !receivedEvent) timer = setTimeout(readPending, 5000);
        });
    };
    readPending();
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [api]);

  const close = (): void => {
    if (!confirmation) return;
    const id = confirmation.id;
    setConfirmation(null);
    void api.dismissConfirmation?.(id).catch(() => undefined);
  };

  return (
    <Dialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent data-testid="external-agent-confirmation-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-emerald-500" aria-hidden="true" />
            {t('general.externalAgentConnection.confirmationTitle')}
          </DialogTitle>
          <DialogDescription>
            {t(
              confirmation?.cdpVerified
                ? 'general.externalAgentConnection.confirmationBoth'
                : 'general.externalAgentConnection.confirmationDescription',
              {
                agentName: confirmation?.agentName ?? '',
              }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={close}>
            {t('general.externalAgentConnection.confirmationClose')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
