import { useSyncExternalStore } from 'react';

import { dockedSidebar } from '../adapters/dockedSidebar';
import { panelController } from '../composition';

const getMode = (): boolean =>
  panelController.getSnapshot().manual || dockedSidebar.getSnapshot().docked;

export function useTaskFolderMode(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const offPanel = panelController.subscribe(onStoreChange);
      const offDocked = dockedSidebar.subscribe(onStoreChange);
      return () => {
        offPanel();
        offDocked();
      };
    },
    getMode,
    getMode
  );
}
