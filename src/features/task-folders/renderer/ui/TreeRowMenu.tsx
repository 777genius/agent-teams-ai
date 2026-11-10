import { useEffect, useRef } from 'react';

import { ContextMenu } from '@renderer/components/ui/context-menu';

import { panelController } from '../composition';

import type { ReactNode } from 'react';

export interface RowMenuLifecycle {
  deferAction(action: () => void, restoreFocus: boolean): void;
  onCloseAutoFocus(event: Event): void;
  onMenuOpenChange(open: boolean): void;
}
interface PendingRowAction {
  run: () => void;
  restoreFocus: boolean;
  activation: number;
}
interface QueuedRowAction {
  cancelled: boolean;
  frame: number | undefined;
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
  const queuedActions = useRef(new Set<QueuedRowAction>());
  const activation = useRef(0);
  const actionSelected = useRef(false);
  const menuOpen = useRef(false);
  useEffect(
    () => () => {
      pendingAction.current = null;
      for (const queued of queuedActions.current) {
        queued.cancelled = true;
        if (queued.frame !== undefined) cancelAnimationFrame(queued.frame);
      }
      queuedActions.current.clear();
      panelController.hold(`menu:context:${id}`, false);
      panelController.hold(`menu:dropdown:${id}`, false);
    },
    [id]
  );
  const lifecycle: RowMenuLifecycle = {
    deferAction(run, restoreFocus) {
      if (activation.current === 0 || actionSelected.current) return;
      actionSelected.current = true;
      pendingAction.current = { run, restoreFocus, activation: activation.current };
    },
    onCloseAutoFocus(event) {
      const action = pendingAction.current;
      pendingAction.current = null;
      if (!action || action.activation !== activation.current) return;
      if (!action.restoreFocus) event.preventDefault();
      const queued: QueuedRowAction = { cancelled: false, frame: undefined };
      queuedActions.current.add(queued);
      queued.frame = requestAnimationFrame(() => {
        queuedActions.current.delete(queued);
        if (queued.cancelled) return;
        queued.cancelled = true;
        action.run();
      });
    },
    onMenuOpenChange(open) {
      if (open && !menuOpen.current) {
        activation.current += 1;
        actionSelected.current = false;
        pendingAction.current = null;
      }
      menuOpen.current = open;
    },
  };
  return (
    <ContextMenu
      onOpenChange={(open) => {
        lifecycle.onMenuOpenChange(open);
        panelController.hold(`menu:context:${id}`, open);
      }}
    >
      {children(lifecycle)}
    </ContextMenu>
  );
};
