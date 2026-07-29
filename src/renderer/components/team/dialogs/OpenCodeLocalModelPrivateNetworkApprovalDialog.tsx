import React, { useState } from 'react';

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
  const [approved, setApproved] = useState(false);
  const cancel = (): void => {
    setApproved(false);
    onCancel();
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && cancel()}>
      <DialogContent data-testid="team-model-selector-private-network-dialog">
        <DialogHeader>
          <DialogTitle>Allow this local network server?</DialogTitle>
          <DialogDescription>
            Agent Teams needs permission for this project before it can add and test the model at{' '}
            <span className="break-all font-mono text-[var(--color-text-secondary)]">
              {target?.baseUrl}
            </span>
            .
          </DialogDescription>
        </DialogHeader>
        <LocalProviderPrivateNetworkApprovalControl
          checked={approved}
          disabled={false}
          onChange={setApproved}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={cancel}>
            Cancel
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
            Allow and test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
