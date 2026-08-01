import React, { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  LocalProviderPrivateNetworkApprovalControl,
  type OpenCodeLocalModelSetupTarget,
} from '@features/runtime-provider-management/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

export const OpenCodeLocalModelPrivateNetworkApprovalDialog = ({
  target,
  onCancel,
  onApprove,
}: {
  target: OpenCodeLocalModelSetupTarget | null;
  onCancel: () => void;
  onApprove: (target: OpenCodeLocalModelSetupTarget) => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [approved, setApproved] = useState(false);
  const cancel = (): void => {
    setApproved(false);
    onCancel();
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && cancel()}>
      <DialogContent data-testid="team-model-selector-private-network-dialog">
        <DialogHeader>
          <DialogTitle>{t('modelSelector.localModels.privateNetworkApproval.title')}</DialogTitle>
          <DialogDescription>
            {t('modelSelector.localModels.privateNetworkApproval.description', {
              baseUrl: target?.baseUrl ?? '',
            })}
          </DialogDescription>
        </DialogHeader>
        <LocalProviderPrivateNetworkApprovalControl
          checked={approved}
          disabled={false}
          onChange={setApproved}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={cancel}>
            {t('modelSelector.localModels.privateNetworkApproval.cancel')}
          </Button>
          <Button
            type="button"
            data-testid="team-model-selector-private-network-approve"
            disabled={!approved || target === null}
            onClick={() => {
              if (!target) return;
              setApproved(false);
              onApprove(target);
            }}
          >
            {t('modelSelector.localModels.privateNetworkApproval.allowAndTest')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
