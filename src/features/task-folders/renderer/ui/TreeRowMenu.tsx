import { useEffect, useRef } from 'react';

import { ContextMenu } from '@renderer/components/ui/context-menu';

import { panelController } from '../composition';

import type { ReactNode } from 'react';

export interface RowMenuLifecycle {
  deferAction(action: () => void, restoreFocus: boolean): void;
  onCloseAutoFocus(event: Event): void;
}
interface PendingRowAction {
  run: () => void;
  restoreFocus: boolean;
}

/** Radix roots do not notify onOpenChange when a virtual row disappears. */
export const RowMenuOwner = ({
  id,
  children,
}: {
  id: string;
  children: (lifecycle: RowMenuLifecycle) => ReactNode;
}): React.JSX.Element => {
  const pendingAction = useRef<PendingRowAction | null>(null);
  const actionFrame = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      pendingAction.current = null;
      if (actionFrame.current !== undefined) {
        cancelAnimationFrame(actionFrame.current);
        actionFrame.current = undefined;
      }
      panelController.hold(`menu:context:${id}`, false);
      panelController.hold(`menu:dropdown:${id}`, false);
    },
    [id]
  );
  const lifecycle: RowMenuLifecycle = {
    deferAction(run, restoreFocus) {
      pendingAction.current = { run, restoreFocus };
    },
    onCloseAutoFocus(event) {
      const action = pendingAction.current;
      pendingAction.current = null;
      if (!action) return;
      if (!action.restoreFocus) event.preventDefault();
      actionFrame.current = requestAnimationFrame(() => {
        actionFrame.current = undefined;
        action.run();
      });
    },
  };
  return (
    <ContextMenu onOpenChange={(open) => panelController.hold(`menu:context:${id}`, open)}>
      {children(lifecycle)}
    </ContextMenu>
  );
};
