import { useSyncExternalStore } from 'react';

import { panelController } from '../composition';

const getMode = (): boolean => panelController.getSnapshot().manual;

export function useTaskFolderMode(): boolean {
  return useSyncExternalStore(panelController.subscribe, getMode, getMode);
}
