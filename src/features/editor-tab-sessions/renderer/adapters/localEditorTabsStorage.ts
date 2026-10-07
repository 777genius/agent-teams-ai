import type { EditorTabsStorage } from '../../core/application/editorTabsRepository';

export const EDITOR_TABS_STORAGE_KEY = 'editor-project-tabs:v1';

export function createLocalEditorTabsStorage(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'>
): EditorTabsStorage {
  let memory: string | null = null;
  let unavailable = false;
  return {
    read() {
      if (!unavailable) {
        try {
          memory = getStorage().getItem(EDITOR_TABS_STORAGE_KEY);
          return memory;
        } catch {
          unavailable = true;
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
          unavailable = true;
        }
      }
    },
  };
}
