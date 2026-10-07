import { createLogger } from '@shared/utils/logger';

import type { EditorTabsStorage } from '../../core/application/editorTabsRepository';

const log = createLogger('EditorTabSessions:storage');

export const EDITOR_TABS_STORAGE_KEY = 'editor-project-tabs:v1';

export function createLocalEditorTabsStorage(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'>
): EditorTabsStorage {
  let memory: string | null = null;
  let unavailable = false;
  const fallbackToMemory = (): void => {
    unavailable = true;
    log.warn('Persistent editor tab storage unavailable; using session memory');
  };
  return {
    read() {
      if (!unavailable) {
        try {
          memory = getStorage().getItem(EDITOR_TABS_STORAGE_KEY);
          return memory;
        } catch {
          fallbackToMemory();
        }
      }
      return memory;
    },
    write(value) {
      memory = value;
      if (!unavailable) {
        try {
          getStorage().setItem(EDITOR_TABS_STORAGE_KEY, value);
        } catch {
          fallbackToMemory();
        }
      }
    },
  };
}
