import { lazy, Suspense } from 'react';

import { TaskDetailLoadingDialog } from '@renderer/components/team/dialogs/TaskDetailLoadingDialog';
import { useStore } from '@renderer/store';

const loadGlobalTaskDetailDialog = () =>
  import('../team/dialogs/GlobalTaskDetailDialog').then((module) => ({
    default: module.GlobalTaskDetailDialog,
  }));

const GlobalTaskDetailDialog = lazy(loadGlobalTaskDetailDialog);

let preloadPromise: ReturnType<typeof loadGlobalTaskDetailDialog> | null = null;

/** Warms up the dialog chunk on user intent (e.g. hovering a task) so the first open is instant. */
export const preloadGlobalTaskDetailDialog = (): void => {
  preloadPromise ??= loadGlobalTaskDetailDialog().catch((error: unknown) => {
    preloadPromise = null;
    throw error;
  });
  preloadPromise.catch(() => undefined);
};

export const GlobalTaskDetailDialogSlot = (): React.JSX.Element | null => {
  const isOpen = useStore((state) => state.globalTaskDetail !== null);
  const closeGlobalTaskDetail = useStore((state) => state.closeGlobalTaskDetail);

  if (!isOpen) {
    return null;
  }

  return (
    <Suspense fallback={<TaskDetailLoadingDialog open onClose={closeGlobalTaskDetail} />}>
      <GlobalTaskDetailDialog />
    </Suspense>
  );
};
