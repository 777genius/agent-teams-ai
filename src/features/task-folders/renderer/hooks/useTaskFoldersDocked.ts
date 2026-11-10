import { useSyncExternalStore } from 'react';

import { dockedSidebar } from '../adapters/dockedSidebar';

export function useTaskFoldersDocked(): boolean {
  return useSyncExternalStore(
    dockedSidebar.subscribe,
    () => dockedSidebar.getSnapshot().docked,
    () => dockedSidebar.getSnapshot().docked
  );
}
