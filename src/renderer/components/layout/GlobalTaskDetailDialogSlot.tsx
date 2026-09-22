import { lazy, Suspense } from 'react';

import { useStore } from '@renderer/store';

const GlobalTaskDetailDialog = lazy(() =>
  import('../team/dialogs/GlobalTaskDetailDialog').then((module) => ({
    default: module.GlobalTaskDetailDialog,
  }))
);

export const GlobalTaskDetailDialogSlot = (): React.JSX.Element | null => {
  const isOpen = useStore((state) => state.globalTaskDetail !== null);

  if (!isOpen) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <GlobalTaskDetailDialog />
    </Suspense>
  );
};
